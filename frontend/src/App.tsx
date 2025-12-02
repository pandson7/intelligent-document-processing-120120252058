import React, { useState } from 'react';
import './App.css';

const API_BASE_URL = 'https://ng2acwghzd.execute-api.us-east-1.amazonaws.com/prod';

interface ProcessingResult {
  documentId: string;
  fileName: string;
  fileType: string;
  processingStatus: string;
  ocrResults: any;
  classification: string;
  summary: string;
  uploadTimestamp: number;
}

function App() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [results, setResults] = useState<ProcessingResult | null>(null);
  const [error, setError] = useState<string>('');

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      const validTypes = ['image/jpeg', 'image/png', 'application/pdf'];
      if (!validTypes.includes(file.type)) {
        setError('Please select a JPEG, PNG, or PDF file');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        setError('File size must be less than 10MB');
        return;
      }
      setSelectedFile(file);
      setError('');
    }
  };

  const uploadFile = async () => {
    if (!selectedFile) return;

    setUploading(true);
    setError('');

    try {
      // Get upload URL
      const uploadResponse = await fetch(
        `${API_BASE_URL}/upload?fileName=${encodeURIComponent(selectedFile.name)}&fileType=${encodeURIComponent(selectedFile.type)}`,
        { method: 'POST' }
      );

      if (!uploadResponse.ok) {
        throw new Error('Failed to get upload URL');
      }

      const { documentId, uploadUrl } = await uploadResponse.json();

      // Upload file to S3
      const s3Response = await fetch(uploadUrl, {
        method: 'PUT',
        body: selectedFile,
        headers: {
          'Content-Type': selectedFile.type,
        },
      });

      if (!s3Response.ok) {
        throw new Error('Failed to upload file');
      }

      setUploading(false);
      setProcessing(true);

      // Poll for results
      pollForResults(documentId);

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setUploading(false);
    }
  };

  const pollForResults = async (documentId: string) => {
    const maxAttempts = 60; // 5 minutes with 5-second intervals
    let attempts = 0;

    const poll = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/results/${documentId}`);
        
        if (!response.ok) {
          throw new Error('Failed to fetch results');
        }

        const result: ProcessingResult = await response.json();

        if (result.processingStatus === 'COMPLETED') {
          setResults(result);
          setProcessing(false);
          return;
        }

        if (result.processingStatus === 'FAILED') {
          setError('Document processing failed');
          setProcessing(false);
          return;
        }

        attempts++;
        if (attempts < maxAttempts) {
          setTimeout(poll, 5000); // Poll every 5 seconds
        } else {
          setError('Processing timeout - please try again');
          setProcessing(false);
        }

      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch results');
        setProcessing(false);
      }
    };

    poll();
  };

  const resetForm = () => {
    setSelectedFile(null);
    setResults(null);
    setError('');
    setUploading(false);
    setProcessing(false);
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>Intelligent Document Processing</h1>
        
        {!results && (
          <div className="upload-section">
            <h2>Upload Document</h2>
            <p>Supported formats: JPEG, PNG, PDF (max 10MB)</p>
            
            <input
              type="file"
              accept=".jpg,.jpeg,.png,.pdf"
              onChange={handleFileSelect}
              disabled={uploading || processing}
            />
            
            {selectedFile && (
              <div className="file-info">
                <p>Selected: {selectedFile.name} ({(selectedFile.size / 1024 / 1024).toFixed(2)} MB)</p>
                <button 
                  onClick={uploadFile} 
                  disabled={uploading || processing}
                  className="upload-btn"
                >
                  {uploading ? 'Uploading...' : 'Upload & Process'}
                </button>
              </div>
            )}
            
            {processing && (
              <div className="processing">
                <p>Processing document... This may take up to 2 minutes.</p>
                <div className="spinner"></div>
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="error">
            <p>Error: {error}</p>
            <button onClick={resetForm}>Try Again</button>
          </div>
        )}

        {results && (
          <div className="results-section">
            <h2>Processing Results</h2>
            
            <div className="result-item">
              <h3>Document Information</h3>
              <p><strong>File:</strong> {results.fileName}</p>
              <p><strong>Type:</strong> {results.fileType}</p>
              <p><strong>Status:</strong> {results.processingStatus}</p>
            </div>

            <div className="result-item">
              <h3>Classification</h3>
              <p className="classification">{results.classification}</p>
            </div>

            <div className="result-item">
              <h3>Summary</h3>
              <p className="summary">{results.summary}</p>
            </div>

            <div className="result-item">
              <h3>Extracted Data (OCR)</h3>
              <pre className="ocr-results">
                {JSON.stringify(results.ocrResults, null, 2)}
              </pre>
            </div>

            <button onClick={resetForm} className="reset-btn">
              Process Another Document
            </button>
          </div>
        )}
      </header>
    </div>
  );
}

export default App;
