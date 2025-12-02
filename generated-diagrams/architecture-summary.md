# Intelligent Document Processing - AWS Architecture Diagrams

## Overview
Generated AWS architecture diagrams for the Intelligent Document Processing application based on the design specifications in `design.md`.

## Generated Diagrams

### 1. Main Architecture Diagram (`idp-architecture.png`)
- **Purpose**: High-level overview of the complete system architecture
- **Components**:
  - User interface with React frontend
  - API Gateway for REST endpoints
  - Lambda functions for serverless compute
  - Step Functions for pipeline orchestration
  - Amazon Bedrock with Claude 4 LLM for AI processing
  - S3 for document storage
  - DynamoDB for results storage
  - CloudWatch for monitoring

### 2. Detailed Processing Flow (`idp-detailed-flow.png`)
- **Purpose**: Comprehensive view of the document processing pipeline
- **Key Features**:
  - Frontend layer with React web application
  - API layer with specific endpoints (POST /upload, GET /results, GET /status)
  - Serverless compute layer with specialized Lambda functions
  - Three-stage processing pipeline (OCR → Classification → Summarization)
  - AI/ML services integration with Bedrock and Claude 4
  - Storage layer with S3 and DynamoDB
  - Monitoring and logging with CloudWatch

### 3. Security & IAM Architecture (`idp-security-iam.png`)
- **Purpose**: Security-focused view showing IAM roles, encryption, and access controls
- **Security Features**:
  - IAM roles for Lambda execution, Step Functions, and Bedrock access
  - Server-side encryption for S3 storage
  - Encryption at rest for DynamoDB
  - KMS key management for encryption
  - CloudTrail for API logging
  - CORS configuration for API Gateway

## Architecture Highlights

### Serverless Design
- All compute resources use serverless services (Lambda, Step Functions)
- Auto-scaling based on demand
- Pay-per-use pricing model

### AI/ML Integration
- Amazon Bedrock with Claude 4 LLM for document processing
- Supports both image (JPEG/PNG) and document (PDF) formats
- Three-stage processing: OCR → Classification → Summarization

### Data Flow
1. User uploads document via React frontend
2. API Gateway routes request to Upload Handler Lambda
3. Document stored in S3, metadata in DynamoDB
4. S3 event triggers Step Functions workflow
5. Sequential processing through three Lambda functions
6. Each stage updates DynamoDB with results
7. Frontend polls for results via API Gateway

### Storage Strategy
- **S3**: Document storage with server-side encryption
- **DynamoDB**: Results and metadata storage with encryption at rest
- **Maximum file size**: 10MB per document
- **Supported formats**: JPEG, PNG, PDF

### Security Implementation
- IAM roles with minimal required permissions
- Encryption for data at rest and in transit
- CloudTrail logging for audit trails
- No authentication required (prototype only)

### Monitoring & Logging
- CloudWatch Logs for Lambda function debugging
- CloudWatch Metrics for performance monitoring
- Step Functions execution history
- API Gateway access logs

## File Locations
All diagrams are stored in:
`/home/pandson/echo-architect-artifacts/intelligent-document-processing-120120252058/generated-diagrams/generated-diagrams/`

- `idp-architecture.png` - Main architecture overview
- `idp-detailed-flow.png` - Detailed processing flow
- `idp-security-iam.png` - Security and IAM architecture

## Technical Specifications Alignment
The diagrams accurately reflect the design specifications including:
- Serverless architecture using AWS Lambda and Step Functions
- Amazon Bedrock integration for AI processing
- DynamoDB as the primary data store (as required)
- React frontend without CloudFront (as specified)
- No authentication implementation (prototype requirement)
- Exclusion of SageMaker, Amplify, and Cognito services
