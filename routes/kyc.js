const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { WebApi } = require('smile-identity-core');

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = './uploads';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ 
    storage: storage,
    limits: {
        fileSize: 10 * 1024 * 1024 // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        // Accept images only
        if (file.mimetype.startsWith('image/')) {
            cb(null, true);
        } else {
            cb(new Error('Only image files are allowed!'), false);
        }
    }
});

// Helper function to generate unique IDs
function generateUniqueId() {
    return Date.now().toString() + Math.random().toString(36).substr(2, 9);
}

// Helper function to convert image to base64
function imageToBase64(filePath) {
    try {
        const imageBuffer = fs.readFileSync(filePath);
        const base64Image = imageBuffer.toString('base64');
        return base64Image;
    } catch (error) {
        console.error('Error converting image to base64:', error);
        throw new Error('Failed to process image');
    }
}

// Helper function to clean up uploaded files
function cleanupFile(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    } catch (error) {
        console.error('Error cleaning up file:', error);
    }
}

// Initialize Smile Identity WebApi - FIXED CONSTRUCTOR
function createSmileApiInstance() {
    const partner_id = process.env.PARTNER_ID;
    const api_key = process.env.API_KEY;
    const sid_server = process.env.ENVIRONMENT === 'production' ? '1' : '0';
    const default_callback = process.env.CALLBACK_URL || 'https://your-callback-url.com/webhook';

    console.log('Creating Smile API instance with:');
    console.log('- Partner ID:', partner_id ? 'Set' : 'Missing');
    console.log('- API Key:', api_key ? `Set (${api_key.length} chars)` : 'Missing');
    console.log('- Server:', sid_server === '1' ? 'Production' : 'Sandbox');
    console.log('- Callback:', default_callback);

    if (!partner_id || !api_key) {
        throw new Error('Missing required environment variables: PARTNER_ID, API_KEY');
    }

    // Correct constructor signature: partner_id, default_callback, api_key, sid_server
    return new WebApi(partner_id, default_callback, api_key, sid_server);
}

// KYC Verification Route
router.post('/verify', upload.single('selfie'), async (req, res) => {
    let uploadedFilePath = null;
    
    try {
        console.log('=== KYC Verification Request Started ===');
        
        // Validate required fields
        const { 
            user_id, 
            id_type, 
            id_number, 
            first_name, 
            last_name, 
            dob, 
            phone_number,
            country = 'NG' // Default to Nigeria
        } = req.body;

        console.log('Request body:', {
            user_id,
            id_type,
            id_number: id_number ? '***masked***' : 'missing',
            first_name,
            last_name,
            dob,
            phone_number: phone_number ? '***masked***' : 'missing',
            country
        });

        // Check for uploaded file
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: 'Selfie image is required'
            });
        }

        uploadedFilePath = req.file.path;
        console.log('Uploaded file:', req.file.filename);

        // Validate required fields
        if (!user_id || !id_type || !id_number || !first_name || !last_name) {
            cleanupFile(uploadedFilePath);
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: user_id, id_type, id_number, first_name, last_name'
            });
        }

        // Convert image to base64
        console.log('Converting image to base64...');
        const base64Image = imageToBase64(uploadedFilePath);
        
        // Create Smile Identity API instance
        console.log('Creating Smile Identity API instance...');
        const webApi = createSmileApiInstance();

        // Generate unique job ID
        const job_id = generateUniqueId();
        console.log('Generated job ID:', job_id);

        // Prepare the request parameters for Enhanced KYC
        const request_params = {
            user_id: user_id,
            job_id: job_id,
            job_type: 5, // Enhanced KYC job type
            images: [
                {
                    image_type_id: 2, // Selfie image type
                    image: base64Image
                }
            ],
            id_info: {
                country: country,
                id_type: id_type,
                id_number: id_number,
                first_name: first_name,
                last_name: last_name,
                dob: dob || null,
                phone_number: phone_number || null
            },
            options: {
                return_job_status: true,
                return_image_links: false,
                return_history: false
            }
        };

        console.log('Submitting job to Smile Identity...');
        console.log('Job parameters:', {
            user_id: request_params.user_id,
            job_id: request_params.job_id,
            job_type: request_params.job_type,
            images_count: request_params.images.length,
            id_info: {
                ...request_params.id_info,
                id_number: '***masked***',
                phone_number: request_params.id_info.phone_number ? '***masked***' : null
            }
        });

        // Submit the job to Smile Identity
        const result = await webApi.submit_job(request_params);
        
        console.log('Smile Identity response received');
        console.log('Response type:', typeof result);
        console.log('Response keys:', Object.keys(result || {}));

        // Clean up the uploaded file
        cleanupFile(uploadedFilePath);

        // Parse the response if it's a string
        let parsedResult = result;
        if (typeof result === 'string') {
            try {
                parsedResult = JSON.parse(result);
            } catch (parseError) {
                console.error('Error parsing Smile Identity response:', parseError);
                return res.status(500).json({
                    success: false,
                    message: 'Invalid response from verification service'
                });
            }
        }

        console.log('Parsed result:', {
            success: parsedResult?.success,
            job_complete: parsedResult?.job_complete,
            job_success: parsedResult?.job_success,
            code: parsedResult?.code
        });

        // Send successful response
        res.json({
            success: true,
            message: 'KYC verification completed',
            data: {
                job_id: job_id,
                user_id: user_id,
                job_complete: parsedResult?.job_complete || false,
                job_success: parsedResult?.job_success || false,
                result_code: parsedResult?.code || null,
                result_text: parsedResult?.result_text || null,
                confidence: parsedResult?.confidence || null,
                actions: parsedResult?.actions || null,
                timestamp: new Date().toISOString()
            },
            raw_response: parsedResult // Include full response for debugging
        });

        console.log('=== KYC Verification Request Completed Successfully ===');

    } catch (error) {
        console.error('=== KYC Verification Error ===');
        console.error('Error type:', error.constructor.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        
        // Clean up uploaded file in case of error
        if (uploadedFilePath) {
            cleanupFile(uploadedFilePath);
        }

        // Handle specific error types
        if (error.code === 'ERR_INVALID_ARG_TYPE') {
            return res.status(500).json({
                success: false,
                message: 'Configuration error: Invalid API credentials',
                error: 'INVALID_CREDENTIALS'
            });
        }

        if (error.message && error.message.includes('partner_id')) {
            return res.status(500).json({
                success: false,
                message: 'Configuration error: Invalid Partner ID',
                error: 'INVALID_PARTNER_ID'
            });
        }

        if (error.message && error.message.includes('api_key')) {
            return res.status(500).json({
                success: false,
                message: 'Configuration error: Invalid API Key',
                error: 'INVALID_API_KEY'
            });
        }

        // Generic error response
        res.status(500).json({
            success: false,
            message: 'KYC verification failed',
            error: error.message || 'Unknown error occurred'
        });
    }
});

// Get Job Status Route
router.get('/status/:job_id', async (req, res) => {
    try {
        const { job_id } = req.params;
        const { user_id } = req.query;

        if (!user_id) {
            return res.status(400).json({
                success: false,
                message: 'user_id query parameter is required'
            });
        }

        console.log(`Getting job status for job_id: ${job_id}, user_id: ${user_id}`);

        const webApi = createSmileApiInstance();
        const result = await webApi.get_job_status(user_id, job_id);

        let parsedResult = result;
        if (typeof result === 'string') {
            try {
                parsedResult = JSON.parse(result);
            } catch (parseError) {
                console.error('Error parsing job status response:', parseError);
                return res.status(500).json({
                    success: false,
                    message: 'Invalid response from status service'
                });
            }
        }

        res.json({
            success: true,
            message: 'Job status retrieved successfully',
            data: parsedResult
        });

    } catch (error) {
        console.error('Error getting job status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to get job status',
            error: error.message
        });
    }
});

// Test Route to verify API configuration
router.get('/test-config', (req, res) => {
    try {
        const webApi = createSmileApiInstance();
        
        res.json({
            success: true,
            message: 'Smile Identity API configuration is valid',
            config: {
                partner_id: process.env.PARTNER_ID ? 'Set' : 'Missing',
                api_key: process.env.API_KEY ? `Set (${process.env.API_KEY.length} chars)` : 'Missing',
                environment: process.env.ENVIRONMENT || 'sandbox',
                callback_url: process.env.CALLBACK_URL || 'Not set'
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Smile Identity API configuration error',
            error: error.message
        });
    }
});

module.exports = router;