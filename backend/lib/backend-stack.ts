import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';
import * as sfnTasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { Construct } from 'constructs';

export class BackendStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const suffix = '120120252058';

    // S3 Bucket for document storage
    const documentBucket = new s3.Bucket(this, `DocumentBucket${suffix}`, {
      bucketName: `idp-documents-${suffix}`,
      cors: [{
        allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.POST, s3.HttpMethods.PUT],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
      }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // DynamoDB table for processing results
    const processingTable = new dynamodb.Table(this, `ProcessingTable${suffix}`, {
      tableName: `DocumentProcessing${suffix}`,
      partitionKey: { name: 'DocumentId', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PROVISIONED,
      readCapacity: 5,
      writeCapacity: 5,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Enable auto scaling
    processingTable.autoScaleReadCapacity({
      minCapacity: 1,
      maxCapacity: 10,
    });
    processingTable.autoScaleWriteCapacity({
      minCapacity: 1,
      maxCapacity: 10,
    });

    // IAM role for Lambda functions
    const lambdaRole = new iam.Role(this, `LambdaRole${suffix}`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
      inlinePolicies: {
        BedrockPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['bedrock:InvokeModel'],
              resources: [
                `arn:aws:bedrock:us-east-1:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-20250514-v1:0`,
                `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0`
              ],
            }),
          ],
        }),
        S3Policy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['s3:GetObject', 's3:PutObject'],
              resources: [`${documentBucket.bucketArn}/*`],
            }),
          ],
        }),
        DynamoDBPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['dynamodb:PutItem', 'dynamodb:GetItem', 'dynamodb:UpdateItem'],
              resources: [processingTable.tableArn],
            }),
          ],
        }),
        StepFunctionsPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ['states:StartExecution'],
              resources: ['*'],
            }),
          ],
        }),
      },
    });

    // Upload Lambda function
    const uploadFunction = new lambda.Function(this, `UploadFunction${suffix}`, {
      functionName: `idp-upload-${suffix}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: lambdaRole,
      code: lambda.Code.fromInline(`
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { randomUUID } = require('crypto');

const dynamodb = new DynamoDBClient({});

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const documentId = randomUUID();
    const fileName = event.queryStringParameters?.fileName || 'unknown';
    const fileType = event.queryStringParameters?.fileType || 'unknown';
    
    // Store initial record in DynamoDB
    await dynamodb.send(new PutItemCommand({
      TableName: '${processingTable.tableName}',
      Item: {
        DocumentId: { S: documentId },
        FileName: { S: fileName },
        FileType: { S: fileType },
        UploadTimestamp: { N: Date.now().toString() },
        ProcessingStatus: { S: 'UPLOADED' }
      }
    }));

    // Generate presigned URL for S3 upload
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
    
    const s3Client = new S3Client({});
    const command = new PutObjectCommand({
      Bucket: '${documentBucket.bucketName}',
      Key: documentId,
      ContentType: fileType
    });
    
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ documentId, uploadUrl })
    };
  } catch (error) {
    console.error('Upload error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Upload failed' })
    };
  }
};
      `),
      environment: {
        TABLE_NAME: processingTable.tableName,
        BUCKET_NAME: documentBucket.bucketName,
      },
    });

    // OCR Processing Lambda
    const ocrFunction = new lambda.Function(this, `OCRFunction${suffix}`, {
      functionName: `idp-ocr-${suffix}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: lambdaRole,
      timeout: cdk.Duration.minutes(5),
      code: lambda.Code.fromInline(`
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const s3 = new S3Client({});
const dynamodb = new DynamoDBClient({});

exports.handler = async (event) => {
  const documentId = event.documentId;
  const fileName = event.fileName;
  const fileType = event.fileType;

  try {
    // Get document from S3
    const s3Response = await s3.send(new GetObjectCommand({
      Bucket: '${documentBucket.bucketName}',
      Key: documentId
    }));
    
    const documentBytes = await s3Response.Body.transformToByteArray();
    const base64Document = Buffer.from(documentBytes).toString('base64');

    let bedrockRequest;
    
    if (fileType.includes('pdf')) {
      bedrockRequest = {
        modelId: 'arn:aws:bedrock:us-east-1:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-20250514-v1:0',
        contentType: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: [{
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64Document
              }
            }, {
              type: 'text',
              text: 'Extract all text and data from this document as key-value pairs in JSON format. Return only the JSON, no other text.'
            }]
          }]
        })
      };
    } else {
      const mediaType = fileType === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      bedrockRequest = {
        modelId: 'arn:aws:bedrock:us-east-1:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-20250514-v1:0',
        contentType: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: [{
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Document
              }
            }, {
              type: 'text',
              text: 'Extract all text and data from this image as key-value pairs in JSON format. Return only the JSON, no other text.'
            }]
          }]
        })
      };
    }

    const response = await bedrock.send(new InvokeModelCommand(bedrockRequest));
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    let ocrText = responseBody.content[0].text;

    // Handle markdown-wrapped JSON
    const jsonMatch = ocrText.match(/\`\`\`(?:json)?\s*(\{[\s\S]*\})\s*\`\`\`/);
    if (jsonMatch) {
      ocrText = jsonMatch[1];
    }

    let ocrResults;
    try {
      ocrResults = JSON.parse(ocrText);
    } catch {
      ocrResults = { extracted_text: ocrText };
    }

    // Update DynamoDB
    await dynamodb.send(new UpdateItemCommand({
      TableName: '${processingTable.tableName}',
      Key: { DocumentId: { S: documentId } },
      UpdateExpression: 'SET OCRResults = :ocr, ProcessingStatus = :status',
      ExpressionAttributeValues: {
        ':ocr': { S: JSON.stringify(ocrResults) },
        ':status': { S: 'OCR_COMPLETE' }
      }
    }));

    return { documentId, fileName, fileType, ocrResults };
  } catch (error) {
    console.error('OCR error:', error);
    await dynamodb.send(new UpdateItemCommand({
      TableName: '${processingTable.tableName}',
      Key: { DocumentId: { S: documentId } },
      UpdateExpression: 'SET ProcessingStatus = :status, ErrorMessages = :error',
      ExpressionAttributeValues: {
        ':status': { S: 'FAILED' },
        ':error': { SS: [error.message] }
      }
    }));
    throw error;
  }
};
      `),
      environment: {
        TABLE_NAME: processingTable.tableName,
        BUCKET_NAME: documentBucket.bucketName,
      },
    });

    // Classification Lambda
    const classificationFunction = new lambda.Function(this, `ClassificationFunction${suffix}`, {
      functionName: `idp-classification-${suffix}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: lambdaRole,
      timeout: cdk.Duration.minutes(2),
      code: lambda.Code.fromInline(`
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const dynamodb = new DynamoDBClient({});

exports.handler = async (event) => {
  const { documentId, ocrResults } = event;

  try {
    const ocrText = JSON.stringify(ocrResults);
    
    const bedrockRequest = {
      modelId: 'arn:aws:bedrock:us-east-1:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-20250514-v1:0',
      contentType: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: \`Classify this document into one of these categories: Dietary Supplement, Stationery, Kitchen Supplies, Medicine, Driver License, Invoice, W2, Other. 

Document content: \${ocrText}

Return only the category name, nothing else.\`
        }]
      })
    };

    const response = await bedrock.send(new InvokeModelCommand(bedrockRequest));
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    let classification = responseBody.content[0].text.trim();

    const validCategories = ['Dietary Supplement', 'Stationery', 'Kitchen Supplies', 'Medicine', 'Driver License', 'Invoice', 'W2', 'Other'];
    if (!validCategories.includes(classification)) {
      classification = 'Other';
    }

    // Update DynamoDB
    await dynamodb.send(new UpdateItemCommand({
      TableName: '${processingTable.tableName}',
      Key: { DocumentId: { S: documentId } },
      UpdateExpression: 'SET Classification = :classification, ProcessingStatus = :status',
      ExpressionAttributeValues: {
        ':classification': { S: classification },
        ':status': { S: 'CLASSIFICATION_COMPLETE' }
      }
    }));

    return { ...event, classification };
  } catch (error) {
    console.error('Classification error:', error);
    await dynamodb.send(new UpdateItemCommand({
      TableName: '${processingTable.tableName}',
      Key: { DocumentId: { S: documentId } },
      UpdateExpression: 'SET Classification = :classification, ProcessingStatus = :status',
      ExpressionAttributeValues: {
        ':classification': { S: 'Other' },
        ':status': { S: 'CLASSIFICATION_COMPLETE' }
      }
    }));
    return { ...event, classification: 'Other' };
  }
};
      `),
      environment: {
        TABLE_NAME: processingTable.tableName,
      },
    });

    // Summarization Lambda
    const summarizationFunction = new lambda.Function(this, `SummarizationFunction${suffix}`, {
      functionName: `idp-summarization-${suffix}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: lambdaRole,
      timeout: cdk.Duration.minutes(2),
      code: lambda.Code.fromInline(`
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const bedrock = new BedrockRuntimeClient({ region: 'us-east-1' });
const dynamodb = new DynamoDBClient({});

exports.handler = async (event) => {
  const { documentId, ocrResults } = event;

  try {
    const ocrText = JSON.stringify(ocrResults);
    
    const bedrockRequest = {
      modelId: 'arn:aws:bedrock:us-east-1:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-20250514-v1:0',
      contentType: 'application/json',
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: \`Create a concise summary of this document content:

\${ocrText}

Provide a brief, informative summary in 2-3 sentences.\`
        }]
      })
    };

    const response = await bedrock.send(new InvokeModelCommand(bedrockRequest));
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    const summary = responseBody.content[0].text.trim();

    // Update DynamoDB
    await dynamodb.send(new UpdateItemCommand({
      TableName: '${processingTable.tableName}',
      Key: { DocumentId: { S: documentId } },
      UpdateExpression: 'SET Summary = :summary, ProcessingStatus = :status',
      ExpressionAttributeValues: {
        ':summary': { S: summary },
        ':status': { S: 'COMPLETED' }
      }
    }));

    return { ...event, summary };
  } catch (error) {
    console.error('Summarization error:', error);
    await dynamodb.send(new UpdateItemCommand({
      TableName: '${processingTable.tableName}',
      Key: { DocumentId: { S: documentId } },
      UpdateExpression: 'SET Summary = :summary, ProcessingStatus = :status',
      ExpressionAttributeValues: {
        ':summary': { S: 'Summary generation failed' },
        ':status': { S: 'COMPLETED' }
      }
    }));
    return { ...event, summary: 'Summary generation failed' };
  }
};
      `),
      environment: {
        TABLE_NAME: processingTable.tableName,
      },
    });

    // Results retrieval Lambda
    const resultsFunction = new lambda.Function(this, `ResultsFunction${suffix}`, {
      functionName: `idp-results-${suffix}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: lambdaRole,
      code: lambda.Code.fromInline(`
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');

const dynamodb = new DynamoDBClient({});

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const documentId = event.pathParameters.documentId;
    
    const response = await dynamodb.send(new GetItemCommand({
      TableName: '${processingTable.tableName}',
      Key: { DocumentId: { S: documentId } }
    }));

    if (!response.Item) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Document not found' })
      };
    }

    const item = response.Item;
    const result = {
      documentId: item.DocumentId.S,
      fileName: item.FileName?.S,
      fileType: item.FileType?.S,
      processingStatus: item.ProcessingStatus?.S,
      ocrResults: item.OCRResults?.S ? JSON.parse(item.OCRResults.S) : null,
      classification: item.Classification?.S,
      summary: item.Summary?.S,
      uploadTimestamp: item.UploadTimestamp?.N ? parseInt(item.UploadTimestamp.N) : null
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };
  } catch (error) {
    console.error('Results error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to retrieve results' })
    };
  }
};
      `),
      environment: {
        TABLE_NAME: processingTable.tableName,
      },
    });

    // Step Functions state machine
    const ocrTask = new sfnTasks.LambdaInvoke(this, `OCRTask${suffix}`, {
      lambdaFunction: ocrFunction,
      outputPath: '$.Payload',
    });

    const classificationTask = new sfnTasks.LambdaInvoke(this, `ClassificationTask${suffix}`, {
      lambdaFunction: classificationFunction,
      outputPath: '$.Payload',
    });

    const summarizationTask = new sfnTasks.LambdaInvoke(this, `SummarizationTask${suffix}`, {
      lambdaFunction: summarizationFunction,
      outputPath: '$.Payload',
    });

    const definition = ocrTask
      .next(classificationTask)
      .next(summarizationTask);

    const stateMachine = new stepfunctions.StateMachine(this, `IDPStateMachine${suffix}`, {
      stateMachineName: `idp-pipeline-${suffix}`,
      definition,
    });

    // Pipeline trigger Lambda
    const pipelineTriggerFunction = new lambda.Function(this, `PipelineTriggerFunction${suffix}`, {
      functionName: `idp-pipeline-trigger-${suffix}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: lambdaRole,
      code: lambda.Code.fromInline(`
const { SFNClient, StartExecutionCommand } = require('@aws-sdk/client-sfn');
const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');

const stepfunctions = new SFNClient({});
const dynamodb = new DynamoDBClient({});

exports.handler = async (event) => {
  for (const record of event.Records) {
    if (record.eventName === 'ObjectCreated:Put') {
      const documentId = record.s3.object.key;
      
      try {
        // Get document metadata from DynamoDB
        const response = await dynamodb.send(new GetItemCommand({
          TableName: '${processingTable.tableName}',
          Key: { DocumentId: { S: documentId } }
        }));

        if (response.Item) {
          const fileName = response.Item.FileName.S;
          const fileType = response.Item.FileType.S;

          // Update status to processing
          await dynamodb.send(new UpdateItemCommand({
            TableName: '${processingTable.tableName}',
            Key: { DocumentId: { S: documentId } },
            UpdateExpression: 'SET ProcessingStatus = :status',
            ExpressionAttributeValues: {
              ':status': { S: 'PROCESSING' }
            }
          }));

          // Start Step Functions execution
          await stepfunctions.send(new StartExecutionCommand({
            stateMachineArn: '${stateMachine.stateMachineArn}',
            name: \`execution-\${documentId}-\${Date.now()}\`,
            input: JSON.stringify({
              documentId,
              fileName,
              fileType
            })
          }));
        }
      } catch (error) {
        console.error('Pipeline trigger error:', error);
      }
    }
  }
};
      `),
      environment: {
        STATE_MACHINE_ARN: stateMachine.stateMachineArn,
        TABLE_NAME: processingTable.tableName,
      },
    });

    // Add S3 event notification
    documentBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.LambdaDestination(pipelineTriggerFunction)
    );

    // API Gateway
    const api = new apigateway.RestApi(this, `IDPAPI${suffix}`, {
      restApiName: `idp-api-${suffix}`,
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
      },
    });

    const uploadIntegration = new apigateway.LambdaIntegration(uploadFunction);
    api.root.addResource('upload').addMethod('POST', uploadIntegration);

    const resultsResource = api.root.addResource('results');
    const resultsIntegration = new apigateway.LambdaIntegration(resultsFunction);
    resultsResource.addResource('{documentId}').addMethod('GET', resultsIntegration);

    // Output API Gateway URL
    new cdk.CfnOutput(this, 'ApiGatewayUrl', {
      value: api.url,
      description: 'API Gateway URL',
    });
  }
}
