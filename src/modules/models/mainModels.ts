/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: BSD-3-Clause
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import "reflect-metadata";
import "es6-shim";
import { Type } from "class-transformer";
import { Query } from 'soql-parser-js';
import { CommonUtils } from "../components/commonUtils";
import { DATA_MEDIA_TYPE, OPERATION, CONSTANTS } from "../components/statics";
import { MessageUtils, RESOURCES } from "../components/messages";
import { CommandInitializationError } from "./errorsModels";
import { ApiSf } from "../components/apiSf";
var jsforce = require("jsforce");
import {
    parseQuery,
    composeQuery,
    FieldType,
    OrderByClause,
    Field as SOQLField,
    getComposedField
} from 'soql-parser-js';



// --------------------  Script ------------------------------// 
/**
 * The script object which is parsed from the script file
 *
 * @export
 * @class Script
 */
export class Script {

    @Type(() => ScriptOrg)
    orgs: ScriptOrg[] = new Array<ScriptOrg>();

    @Type(() => ScriptObject)
    objects: ScriptObject[] = new Array<ScriptObject>();

    pollingIntervalMs: number = CONSTANTS.DEFAULT_POLLING_INTERVAL_MS;
    bulkThreshold: number = CONSTANTS.DEFAULT_BULK_API_THRESHOLD_RECORDS;
    bulkApiVersion: string = CONSTANTS.DEFAULT_BULK_API_VERSION;
    bulkApiV1BatchSize: number = CONSTANTS.DEFAULT_BULK_API_V1_BATCH_SIZE;
    allOrNone: boolean = false;
    promptOnUpdateError: boolean = true;
    promptOnMissingParentObjects: boolean = true;
    validateCSVFilesOnly: boolean = false;
    encryptDataFiles: boolean = false;
    apiVersion: string = CONSTANTS.DEFAULT_API_VERSION;
    createTargetCSVFiles: boolean = true;
    importCSVFilesAsIs = false;


    // -----------------------------------
    logger: MessageUtils;
    sourceOrg: ScriptOrg;
    targetOrg: ScriptOrg;
    basePath: string = "";
    objectsMap: Map<string, ScriptObject> = new Map<string, ScriptObject>();




    /**
     * Setup this object
     *
     * @param {MessageUtils} logger
     * @param {string} sourceUsername
     * @param {string} targetUsername
     * @param {string} basePath
     * @param {string} apiVersion
     * @returns {Promise<void>}
     * @memberof Script
     */
    async setupAsync(logger: MessageUtils, sourceUsername: string, targetUsername: string, basePath: string, apiVersion: string): Promise<void> {

        // Initialize script
        this.logger = logger;
        this.basePath = basePath;
        this.sourceOrg = this.orgs.filter(x => x.name == sourceUsername)[0] || new ScriptOrg();
        this.targetOrg = this.orgs.filter(x => x.name == targetUsername)[0] || new ScriptOrg();
        this.apiVersion = apiVersion || this.apiVersion;


        // Remove excluded objects
        this.objects = this.objects.filter(object => {
            let included = (!object.excluded || object.operation == OPERATION.Readonly);
            if (!included) {
                this.logger.infoVerbose(RESOURCES.objectWillBeExcluded, object.name);
            }
            return included;
        });

        // Check objects length
        if (this.objects.length == 0) {
            throw new CommandInitializationError(this.logger.getResourceString(RESOURCES.noObjectsDefinedInPackageFile));
        }

        // Assign orgs
        Object.assign(this.sourceOrg, {
            script: this,
            name: sourceUsername,
            isSource: true,
            media: sourceUsername.toLowerCase() == "csvfile" ? DATA_MEDIA_TYPE.File : DATA_MEDIA_TYPE.Org
        });
        Object.assign(this.targetOrg, {
            script: this,
            name: targetUsername,
            media: targetUsername.toLowerCase() == "csvfile" ? DATA_MEDIA_TYPE.File : DATA_MEDIA_TYPE.Org
        });

        // Setup orgs
        await this.sourceOrg.setupAsync();
        await this.targetOrg.setupAsync();

        // Setup objects
        for (let index = 0; index < this.objects.length; index++) {
            const object = this.objects[index];
            object.setup(this);
        }

        // Remove unnecessary objects
        this.objects = this.objects.filter(x => CONSTANTS.NOT_SUPPORTED_OBJECTS.indexOf(x.name) < 0);

        // Add extra objects
        // -- Add RecordType object  
        let objectsWithRecordTypeFields = this.objects.filter(x => x.hasRecordTypeIdField).map(x => x.name);
        if (objectsWithRecordTypeFields.length > 0) {
            let object = new ScriptObject();
            this.objects.push(object);
            Object.assign(object, <ScriptObject>{
                name: "RecordType",
                externalId: "DeveloperName",
                isExtraObject: true,
                allRecords: true,
                query: "SELECT Id FROM RecordType",
                operation: OPERATION.Readonly
            });

            object.setup(this);
            object.parsedQuery.where = CommonUtils.composeWhereClause(object.parsedQuery.where, "SobjectType", objectsWithRecordTypeFields);
            object.parsedQuery.orderBy = <OrderByClause>({
                field: "SobjectType",
                order: "ASC"
            });
            object.query = composeQuery(object.parsedQuery);
        }
    }



    /**
     * Retrieve description of all objects in the script
     *
     * @returns {Promise<void>}
     * @memberof Script
     */
    async describeSObjectsAsync(): Promise<void> {
        this.logger.infoMinimal(RESOURCES.gettingOrgMetadata);

    }
}




/**
 * The org object which is parsed from the script file 
 *
 * @export
 * @class ScriptOrg
 */
export class ScriptOrg {

    name: string = "";
    instanceUrl: string = "";
    accessToken: string = "";


    // -----------------------------------
    script: Script;
    media: DATA_MEDIA_TYPE.File;
    isSource: boolean = false;
    isPersonAccountEnabled: boolean = false;

    getConnection(): any {
        return new jsforce.Connection({
            instanceUrl: this.instanceUrl,
            accessToken: this.accessToken,
            version: this.script.apiVersion,
            maxRequest: CONSTANTS.MAX_CONCURRENT_PARALLEL_REQUESTS
        });
    }

    get isConnected(): boolean {
        return !!this.accessToken;
    }

    get isFileMedia(): boolean {
        return this.media == DATA_MEDIA_TYPE.File;
    }




    /**
     * Setup this object
     *
     * @returns {Promise<void>}
     * @memberof ScriptOrg
     */
    async setupAsync(): Promise<void> {
        // Setup and verify org connection
        await this._setupConnection();
    }




    // ---------------- Private members ---------------------------//
    // ------------------------------------------------------------//
    private _parseForceOrgDisplayResult(commandResult: String): OrgInfo {
        if (!commandResult) return null;
        let lines = commandResult.split('\n');
        let output: OrgInfo = new OrgInfo();
        lines.forEach(line => {
            if (line.startsWith("Access Token"))
                output.AccessToken = line.split(' ').pop();
            if (line.startsWith("Client Id"))
                output.ClientId = line.split(' ').pop();
            if (line.startsWith("Connected Status"))
                output.ConnectedStatus = line.split(' ').pop();
            if (line.startsWith("Status"))
                output.Status = line.split(' ').pop();
            if (line.startsWith("Id"))
                output.OrgId = line.split(' ').pop();
            if (line.startsWith("Instance Url"))
                output.InstanceUrl = line.split(' ').pop();
            if (line.startsWith("Username"))
                output.Username = line.split(' ').pop();
        });
        return output;
    };


    private async _validateAccessTokenAsync(): Promise<void> {
        let apiSf = new ApiSf(this);
        if (!this.isFileMedia) {
            try {
                // Validate access token
                await apiSf.queryAsync("SELECT Id FROM Account LIMIT 1", false);
            } catch (ex) {
                throw new CommandInitializationError(this.script.logger.getResourceString(RESOURCES.accessToOrgExpired, this.name));
            }
            try {
                // Check person account availability
                await apiSf.queryAsync("SELECT IsPersonAccount FROM Account LIMIT 1", false);
                this.isPersonAccountEnabled = true;
            } catch (ex) {
                this.isPersonAccountEnabled = false;
            }
        }
    }


    private async _setupConnection(): Promise<void> {
        if (!this.isFileMedia) {
            if (!this.isConnected) {
                // Connect with SFDX
                this.script.logger.infoNormal(RESOURCES.tryingToConnectCLI, this.name);
                let processResult = CommonUtils.execSfdx("force:org:display", this.name);
                let orgInfo = this._parseForceOrgDisplayResult(processResult);
                if (!orgInfo.isConnected) {
                    throw new CommandInitializationError(this.script.logger.getResourceString(RESOURCES.tryingToConnectCLIFailed, this.name));
                } else {
                    Object.assign(this, {
                        accessToken: orgInfo.AccessToken,
                        instanceUrl: orgInfo.InstanceUrl
                    });
                }
            }

            // Validate connection and check person account availability
            await this._validateAccessTokenAsync();
            this.script.logger.infoNormal(RESOURCES.successfullyConnected, this.name);
        }
    }

}




/**
 * Parsed object from the script file 
 *
 * @export
 * @class ScriptObject
 */
export class ScriptObject {

    @Type(() => ScriptMockField)
    mockFields: ScriptMockField[] = new Array<ScriptMockField>();

    query: string = "";
    deleteQuery: string = "";
    operation: OPERATION = OPERATION.Readonly;
    externalId: string = "Name";
    deleteOldData: boolean = false;
    updateWithMockData: boolean = false;
    mockCSVData: boolean = false;
    targetRecordsFilter: string = "";
    excluded: boolean = false;
    useCSVValuesMapping: boolean = false;
    allRecords: boolean = true;


    // -----------------------------------
    script: Script;
    name: string = "";
    sObjectDescribeSource = new SObjectDescribe();
    sObjectDescribeTarget = new SObjectDescribe();
    sourceFieldsMap = new Map<string, SFieldDescribe>();
    targetFieldsMap = new Map<string, SFieldDescribe>();
    initialExternalId: string = "";
    parsedQuery: Query;
    parsedDeleteQuery: Query;
    isExtraObject: boolean = false;


    get fieldsInQuery(): string[] {
        if (!this.parsedQuery) {
            return new Array<string>();
        }
        return this.parsedQuery.fields.map(x => (<SOQLField>x).field);
    }

    get fieldsToUpdate(): string[] {
        if (!this.parsedQuery
            || this.sourceFieldsMap.size == 0
            || this.operation == OPERATION.Readonly) {
            return new Array<string>();
        }
        return this.parsedQuery.fields.map(x => {
            let name = (<SOQLField>x).field;
            let describe = this.targetFieldsMap.get(name) && this.sourceFieldsMap.get(name);
            if (!describe || describe.isReadonly) {
                return null;
            }
            return (<SOQLField>x).field;
        }).filter(x => !!x);
    }

    get hasRecordTypeIdField(): boolean {
        return this.fieldsInQuery.some(x => x == "RecordTypeId");
    }

    get strOperation(): string {
        return OPERATION[this.operation];
    }

    get isLimitedQuery(): boolean {
        return this.parsedQuery
            && (this.parsedQuery.limit > 0 || !!this.parsedQuery.where);
    }

    get isSpecialObject(): boolean {
        return [
            "Group",
            "User",
            "RecordType"
        ].indexOf(this.name) >= 0;
    }

    get isComplexExternalId(): boolean {
        return this.externalId.indexOf('.') >= 0
            || this.externalId.indexOf(CONSTANTS.COMPLEX_FIELDS_SEPARATOR) >= 0
            || this.externalId.startsWith(CONSTANTS.COMPLEX_FIELDS_QUERY_PREFIX);
    }

    // FIXME:
    getComplexExternalId(): string {
        return CONSTANTS.COMPLEX_FIELDS_QUERY_PREFIX
            + this.externalId.replace(
                new RegExp(`${CONSTANTS.COMPLEX_FIELDS_SEPARATOR}`, 'g'),
                CONSTANTS.COMPLEX_FIELDS_QUERY_SEPARATOR
            );
    }

    /**
     * Setup this object
     *
     * @param {Script} script
     * @memberof ScriptObject
     */
    setup(script: Script) {

        // Initialize object
        this.script = script;
        this.initialExternalId = this.externalId;

        // Fix operation value
        if ((typeof this.operation == "string") == true) {
            this.operation = OPERATION[this.operation.toString()];
        }

        // Always set explicit externalId to 'Id' on Insert operation
        if (this.operation == OPERATION.Insert) {
            this.externalId = "Id";
        }

        // Parse query string
        try {
            this.parsedQuery = parseQuery(this.query);
            this.parsedQuery.fields = CommonUtils.distinctArray(this.parsedQuery.fields, "field");
            if (this.operation == OPERATION.Delete) {
                this.deleteOldData = true;
                this.parsedQuery.fields = [getComposedField("Id")];
            }
            // Add record Id field to each query
            if (!this.fieldsInQuery.some(x => x == "Id")) {
                this.parsedQuery.fields.push(getComposedField("Id"));
            }
        } catch (ex) {
            throw new CommandInitializationError(this.script.logger.getResourceString(RESOURCES.MalformedQuery, this.name, this.query, ex));
        }

        // Update object
        this.query = composeQuery(this.parsedQuery);
        this.name = this.parsedQuery.sObject;
        this.script.objectsMap.set(this.name, this);

        // Parse delete query string
        if (this.deleteOldData) {
            try {
                if (this.deleteQuery) {
                    this.parsedDeleteQuery = parseQuery(this.deleteQuery);
                } else {
                    this.parsedDeleteQuery = parseQuery(this.query);
                }
                this.parsedDeleteQuery.fields = [getComposedField("Id")];
                if (this.script.sourceOrg.isPersonAccountEnabled && this.name == "Contact") {
                    this.parsedDeleteQuery.where = CommonUtils.composeWhereClause(this.parsedDeleteQuery.where, "IsPersonAccount", "false", "=", "BOOLEAN", "AND");
                }
                this.deleteQuery = composeQuery(this.parsedDeleteQuery);
            } catch (ex) {
                throw new CommandInitializationError(this.script.logger.getResourceString(RESOURCES.MalformedDeleteQuery, this.name, this.deleteQuery, ex));
            }
        }

    }
}




/**
 * Parsed mock field object from the script file
 *
 * @export
 * @class ScriptMockField
 */
export class ScriptMockField {
    name: string = "";
    pattern: string = "";
    excludedRegex: string = "";
    includedRegex: string = "";
}





// --------------------  Metadata Descriptions ------------------------------// 
/**
 * Description of the sobject
 *
 * @export
 * @class SObjectDescribe
 */
export class SObjectDescribe {
    name: string = "";
    label: string = "";
    updateable: boolean = false;
    createable: boolean = false;
    custom: boolean = false;
}



/**
 * Description of the sobject field
 *
 * @export
 * @class SFieldDescribe
 */
export class SFieldDescribe {

    name: string = "";
    type: string = "";
    label: string = "";
    updateable: boolean = false;
    creatable: boolean = false;
    cascadeDelete: boolean = false;
    autoNumber: boolean = false;
    custom: boolean = false;
    calculated: boolean = false;

    isReference: boolean = false;
    referencedObjectType: string = "";

    get isMasterDetail() {
        return this.isReference && (!this.updateable || this.cascadeDelete);
    }

    get isFormula() {
        return this.calculated;
    }

    get isReadonly() {
        return !(this.creatable && !this.isFormula && !this.autoNumber);
    }

    get isBoolean() {
        return this.type == "boolean";
    }

}



/**
 * Force:org:display command response 
 *
 * @export
 * @class OrgInfo
 */
export class OrgInfo {
    AccessToken: string;
    ClientId: string;
    ConnectedStatus: string;
    Status: string;
    OrgId: string;
    UserId: string;
    InstanceUrl: string;
    Username: string;

    get isConnected() {
        return this.ConnectedStatus == "Connected" || this.Status == "Active";
    }
}

