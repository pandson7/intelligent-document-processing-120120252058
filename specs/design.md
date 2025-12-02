# Design Document

## Architecture Overview

The Intelligent Document Processing application follows a serverless architecture using AWS services with a React frontend and Node.js backend. The system processes documents through a sequential pipeline triggered by S3 uploads.

## System Components

### Frontend Layer
- **React Web Application**: Simple upload interface and results display
- **Local Development Server**: Hosts the React application during development
- **File Upload Component**: Handles document selection and upload to S3

### API Layer
- **API Gateway**: RESTful endpoints for document upload and result retrieval
- **Lambda Functions**: Serverless compute for business logic
  - Upload Handler: Processes file uploads and initiates pipeline
  - Results Handler: Retrieves processing results from DynamoDB
  - Pipeline Orchestrator: Manages the three-task sequence

### Processing Layer
- **Amazon Bedrock**: AI/ML services for document processing
  - Claude 4 LLM: Handles OCR, classification, and summarization
  - Image Processing: For JPEG/PNG files
  - Document Processing: For PDF files
- **Step Functions**: Orchestrates the three-task pipeline sequence

### Storage Layer
- **Amazon S3**: Document storage with event triggers
- **DynamoDB**: Results storage with document metadata
  - Primary Key: DocumentId (UUID)
  - Attributes: FileName, FileType, UploadTimestamp, OCRResults, Classification, Summary, ProcessingStatus

## Data Flow Architecture

```
User Upload → React Frontend → API Gateway → Lambda → S3 Storage
                                                         ↓
Step Functions ← S3 Event Trigger
     ↓
Task 1: OCR Processing (Bedrock Claude)
     ↓
Task 2: Classification (Bedrock Claude)  
     ↓
Task 3: Summarization (Bedrock Claude)
     ↓
DynamoDB Storage ← Results
     ↓
Frontend Polling → API Gateway → Lambda → DynamoDB → Results Display
```

## Technical Specifications

### File Format Handling
- **JPEG/PNG Files**: Processed as `image` type in Bedrock Claude
- **PDF Files**: Processed as `document` type in Bedrock Claude
- **Maximum File Size**: 10MB per document
- **Supported MIME Types**: image/jpeg, image/png, application/pdf

### API Endpoints
```
POST /upload
- Accepts multipart/form-data
- Returns: {documentId, uploadStatus}

GET /results/{documentId}
- Returns: {documentId, fileName, ocrResults, classification, summary, status}

GET /status/{documentId}
- Returns: {documentId, processingStatus, completedTasks}
```

### DynamoDB Schema
```
Table: DocumentProcessing
- DocumentId (String, Primary Key)
- FileName (String)
- FileType (String)
- UploadTimestamp (Number)
- ProcessingStatus (String) // UPLOADED, PROCESSING, COMPLETED, FAILED
- OCRResults (Map)
- Classification (String)
- Summary (String)
- ErrorMessages (List)
```

### Step Functions Workflow
```json
{
  "Comment": "IDP Pipeline",
  "StartAt": "OCRTask",
  "States": {
    "OCRTask": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:region:account:function:OCRProcessor",
      "Next": "ClassificationTask"
    },
    "ClassificationTask": {
      "Type": "Task", 
      "Resource": "arn:aws:lambda:region:account:function:ClassificationProcessor",
      "Next": "SummarizationTask"
    },
    "SummarizationTask": {
      "Type": "Task",
      "Resource": "arn:aws:lambda:region:account:function:SummarizationProcessor",
      "End": true
    }
  }
}
```

## Security Considerations

### Access Control
- S3 bucket with restricted public access
- Lambda functions with minimal IAM permissions
- API Gateway with CORS configuration for local development

### Data Protection
- Documents stored in S3 with server-side encryption
- DynamoDB encryption at rest enabled
- No authentication required (prototype only)

## Performance Considerations

### Scalability
- Lambda functions auto-scale based on demand
- DynamoDB on-demand billing for variable workloads
- S3 handles unlimited document storage

### Processing Time
- OCR: 2-10 seconds depending on document complexity
- Classification: 1-3 seconds
- Summarization: 2-5 seconds
- Total pipeline: 5-18 seconds per document

## Error Handling

### Retry Logic
- Lambda functions: 3 retry attempts with exponential backoff
- Step Functions: Built-in error handling and retry policies
- Frontend: Polling with timeout after 60 seconds

### Failure Scenarios
- Unsupported file format: Immediate rejection with error message
- Bedrock service limits: Retry with backoff, fallback to error status
- DynamoDB throttling: Automatic retry with AWS SDK
- Network failures: Client-side retry with user notification

## Development Environment

### Local Setup
- React development server on localhost:3000
- AWS CDK for infrastructure deployment
- Local AWS credentials for development
- Sample documents in ~/ea_sample_docs/idp_docs for testing

### Deployment Strategy
- Single CDK stack deployment
- No CI/CD pipeline (simple deployment)
- Environment variables for AWS resource ARNs
- Local frontend development with API Gateway integration

## Monitoring and Logging

### CloudWatch Integration
- Lambda function logs for debugging
- Step Functions execution history
- API Gateway access logs
- DynamoDB metrics for performance monitoring

### Error Tracking
- Structured logging in Lambda functions
- Error messages stored in DynamoDB
- Frontend error display for user feedback
