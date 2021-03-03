'use strict';
//AWS SDK
const AWS = require('aws-sdk');
AWS.config.region = process.env.REGION;

//AWS dynamodb client
const dynamoDb = new AWS.DynamoDB.DocumentClient();

//AWS S3 client
const S3 = new AWS.S3();

//elasticsearch stuff
const elasticsearch = require('elasticsearch');
const esClient = new elasticsearch.Client({
    host: process.env.BERTRAM_CODING_ES_URL,
    log: 'error',
    maxRetries: 5,
    requestTimeout: 300000,
    connectionClass: require('http-aws-es'),
    amazonES: { credentials: new AWS.EnvironmentCredentials('AWS') }
});

// moment date/time utilities
const moment = require('moment');

// cross-domain HTTP headers to send with responses
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*", 
    "Access-Control-Allow-Credentials": true 
};

// handler for adding names to 3 places: dynamodb table, s3 bucket, elasticsearch
module.exports.add = (event, context, callback) => {
    console.log('add',event);
    let output = {statusCode: null, data: {}, meta: {}, message:null};

    // wrap initial work in a promise
    return new Promise(function(resolve, reject) {
        // read input
        let entry = {dateCreated: moment().format()};        
        if (event.queryStringParameters) entry.display = event.queryStringParameters.name;
        if (!entry.display && event.body) entry.display = JSON.parse(event.body).name;         
        if (!entry.display) {
            output.message = 'Name missing';
            output.statusCode = 400;
            reject(output);
        }
        // normalize the name to use it as a key
        entry.name = entry.display.toLowerCase().trim();

        // check fo existing
        let dynamoDbParams = {
            TableName: process.env.BERTRAM_CODING_GUESTBOOK_DYNAMODB_TABLE,
            Key: {name: entry.name}
        };
        dynamoDb.get(dynamoDbParams, (error, data) => {
            console.log('getFromDynamoDb',JSON.stringify(data), error);
            if (error) {
                reject(error);
            }
            else if (!data || !data.Item) {
                resolve(entry);
            }
            else {
                reject('Entry already exists!');
            }
        });

    })
    .then(function(entry) {
        // put into the object database (dynamodb)
        return new Promise(function(resolve, reject) {
            let dynamoDbParams = {
                TableName: process.env.BERTRAM_CODING_GUESTBOOK_DYNAMODB_TABLE,
                Key: {name: entry.name},
                Item: entry
            };
            dynamoDb.put(dynamoDbParams, (error, dbOutput) => {
                console.log('dbOutput',dbOutput,'error',error);
                if (error) {
                    output.message = error.toString()
                    // fail the wrapper promise
                    reject('Could not save in dynamodb');
                }
                // resolve the wrapper promise
                else resolve(entry);
            });

        });
    })
    .then(function(entry) {
        // save the entry in s3 as a JSON file
        // wrap s3 work in a promise
        return new Promise(function(resolve, reject) {
            let body = JSON.stringify(entry), //string content for s3 object
                // normalized name fo s3 object
                key = 'data/guestbook/'+entry.name.replace(/([^a-z0-9]+)/gi, '_')+'.json',
                // input params for s3 client
                s3Params = { 
                    Bucket: process.env.BERTRAM_CODING_S3_WEB_SITE_BUCKET, 
                    Key: key, 
                    Body: body,
                    ContentType: 'application/json' 
                };
            S3.putObject(s3Params, function (err, data) {
                if (err) {
                    console.log("Could not save object in s3",s3Params, err);
                    output.message = 'Could not save in s3';
                    reject(err);
                }
                else {
                    console.log("Successfully saved object in s3",s3Params, data);
                    resolve(entry);
                }
            });
        });
    })
    .then(function(entry) {
        console.log('s3 output', JSON.stringify(entry));
        // save the entry in ES
        // use a real date
        entry.dateCreated = moment(entry.dateCreated).toDate();
        // already returns a promise
        return esClient.index({
            index: process.env.BERTRAM_CODING_GUESTBOOK_ES_INDEX,
            id: entry.name, // use the lower case name as the unique id
            refresh: "wait_for", //dont return until document is available in the index
            body: entry
        })
        .then(function(esOutput) {
            console.log('esOutput', JSON.stringify(esOutput));
            return Promise.resolve(entry);
        });        
    })    
    .then(function(entry) {
        output.message = 'Entry added';
        output.statusCode = 200;
        callback(null,{statusCode: output.statusCode, headers:CORS_HEADERS,  body: JSON.stringify(output)});

    })
    .catch(function(err) {
        console.log('err', err, JSON.stringify(err));
        output.statusCode = output.statusCode || 500;
        output.message = err;
        callback(null,{statusCode: output.statusCode, headers:CORS_HEADERS, body: JSON.stringify(output)});
    });
};

// handler for listing all guestbook entries using elasticsearch
module.exports.list = (event, context, callback) => {
    console.log('list',event);
    let output = {statusCode: 200, data: [], meta: {}, message:null};
    return esClient.search({
        index: process.env.BERTRAM_CODING_GUESTBOOK_ES_INDEX,
        expand_wildcards: 'all',
        allow_no_indices: true, // do not fail if the index has not been created
        body: {"query":{"match_all":{}}, "sort":{"dateCreated":"asc"}}
    })
    .then(function(esResponse) {
        console.log('done searching ', JSON.stringify(esResponse));
        output.message = 'Entries listed';
        if (esResponse.hits && esResponse.hits.hits)
            output.data = esResponse.hits.hits.map(function(itm) {return itm._source;});
        callback(null,{statusCode: output.statusCode, headers:CORS_HEADERS,  body: JSON.stringify(output)});

    })
    .catch(function(err) {
        console.log('err', JSON.stringify(err));
        callback(null,{statusCode: output.statusCode, headers:CORS_HEADERS, body: JSON.stringify(output)});
    });
};

// handler for deleting all guestbook entries from dynamodb, s3, and elasticsearch
module.exports.clear = (event, context, callback) => {
    console.log('clear',event);
    let output = {statusCode: null, data: {}, meta: {}, message:null};
    // delete things out of the object database
    // first get a list of the keys for the records
    return dynamoDb.scan({
        TableName: process.env.BERTRAM_CODING_GUESTBOOK_DYNAMODB_TABLE,
        AttributesToGet: ['name'],
        Limit: 100000
    })
    .promise()
    .then(function(rows) {
        let allDeletes = [];
        // do individual deletes for each record in the table
        rows.Items.forEach(function(element) {
            allDeletes.push(dynamoDb.delete({
                TableName: process.env.BERTRAM_CODING_GUESTBOOK_DYNAMODB_TABLE,
                Key: element,
            }).promise());
        }); 
        return Promise.all(allDeletes);           
    })
    .then(function() {
        return new Promise(function(resolve, reject) {
            // first get a list of all the s3 keys 
            let params = { 
                Bucket: process.env.BERTRAM_CODING_S3_WEB_SITE_BUCKET, 
                Prefix: 'data/guestbook/',
                MaxKeys: 1000
            };
            S3.listObjectsV2(params, function(err, data) {
                if (err) reject(err);
                else {
                    let keys = [];
                    data.Contents.forEach(function(obj) {
                        keys.push(obj.Key);
                    });
                    console.log('keys',keys);
                    resolve(keys);    
                }
            });    
        })
        .then(function(keys) {
            let deletes = [];
            // delete each s3 object by key
            keys.forEach(function(key) {
                let params = { 
                    Bucket: process.env.BERTRAM_CODING_S3_WEB_SITE_BUCKET, 
                    Key: key
                };
                deletes.push(new Promise(function(resolve, reject) {
                    S3.deleteObject(params, function (err, data) {
                        if (err) reject(err);
                        else resolve(data);
                    })
                }));
            })
            return Promise.all(deletes);    
        });
    })
    .then(function(s3output) {
        console.log('s3 output', JSON.stringify(s3output));
        // delete the entire elasticsearch index
        return esClient.indices.delete({ "allow_no_indices":true, "index": process.env.BERTRAM_CODING_GUESTBOOK_ES_INDEX });
    })    
    .then(function(esOutput) {
        console.log('ES output', JSON.stringify(esOutput));
        output.message = 'All entries cleared';
        output.statusCode = 200;
        callback(null,{statusCode: output.statusCode, headers:CORS_HEADERS,  body: JSON.stringify(output)});

    })
    .catch(function(err) {
        console.log('err', err, JSON.stringify(err));
        output.statusCode = output.statusCode || 500;
        callback(null,{statusCode: output.statusCode, headers:CORS_HEADERS, body: JSON.stringify(output)});
    });
};

