import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import tesseract from 'node-tesseract-ocr';
import fetch from 'node-fetch';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Logger setup
class Logger {
    constructor(logDir = 'logs') {
        this.logDir = logDir;
        this.logFile = null;
        this.initLogFile();
    }

    initLogFile() {
        // Create logs directory if it doesn't exist
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir);
        }

        // Create new log file with timestamp
        const date = new Date().toISOString().split('T')[0];
        const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\..+/, '');
        this.logFile = path.join(this.logDir, `process-log-${date}.txt`);
    }

    formatMessage(level, message) {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] [${level}] ${message}\n`;
    }

    log(level, message) {
        const formattedMessage = this.formatMessage(level, message);

        // Write to console
        console.log(formattedMessage.trim());

        // Write to file
        fs.appendFileSync(this.logFile, formattedMessage);
    }

    info(message) {
        this.log('INFO', message);
    }

    error(message) {
        this.log('ERROR', message);
    }

    success(message) {
        this.log('SUCCESS', message);
    }

    summary(processedFiles) {
        const successCount = processedFiles.filter(f => f.success).length;
        const failureCount = processedFiles.filter(f => !f.success).length;

        const summaryMessage = [
            '\n=== Processing Summary ===',
            `Total Files Processed: ${processedFiles.length}`,
            `Successful: ${successCount}`,
            `Failed: ${failureCount}`,
            '\nDetailed Results:',
            ...processedFiles.map(result =>
                `${result.success ? '✓' : '✗'} ${result.fileName}: ${result.message}` +
                (result.orderNumber ? ` (Order: ${result.orderNumber})` : '') +
                (result.trackingNumber ? ` (Tracking: ${result.trackingNumber})` : '')
            ),
            '======================='
        ].join('\n');

        this.log('SUMMARY', summaryMessage);
    }
}

const logger = new Logger();

// Rest of the functions modified to use logger
async function processOrder(orderNumber, trackingNumber) {
    try {
        const response = await fetch('https://shipstation-proxy.info-ba2.workers.dev/orders?orderNumber=' + orderNumber, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }

        const data = await response.json();
        if (!data.orders || data.orders.length === 0) {
            throw new Error('Order not found');
        }

        const firstUnfulfilled = data.orders.find(order => order.orderStatus === "awaiting_shipment");
        if (!firstUnfulfilled) {
            throw new Error('No unfulfilled order found');
        }

        logger.info(`Found unfulfilled order: ${firstUnfulfilled.orderId}`);

        // Mark as shipped
        const markShippedResponse = await fetch('https://shipstation-proxy.info-ba2.workers.dev/orders/markasshipped', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                orderId: firstUnfulfilled.orderId,
                carrierCode: 'usps',
                trackingNumber: trackingNumber,
                notifyCustomer: true,
                notifySalesChannel: true
            }),
        });

        if (!markShippedResponse.ok) {
            throw new Error(`Failed to mark as shipped: ${markShippedResponse.status}`);
        }

        logger.info(`Marked order ${firstUnfulfilled.orderId} as shipped`);

        // Assign user
        const assignUserResponse = await fetch('https://shipstation-proxy.info-ba2.workers.dev/orders/assignuser', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                orderIds: [firstUnfulfilled.orderId],
                userId: "1f021469-eff0-4cf3-a9ab-e6edccdc84f7"
            })
        });

        if (!assignUserResponse.ok) {
            throw new Error(`Failed to assign user: ${assignUserResponse.status}`);
        }

        logger.info(`Assigned user to order ${firstUnfulfilled.orderId}`);
        return { success: true, message: 'Order processed successfully' };
    } catch (error) {
        logger.error(`Error processing order: ${error.message}`);
        return { success: false, message: error.message };
    }
}

async function convertPDFToImage(pdfPath) {
    const imagePath = pdfPath.replace('.pdf', '.png');

    try {
        logger.info(`Converting PDF to image: ${pdfPath}`);
        await execAsync(`pdftoppm -png -r 300 "${pdfPath}" "${pdfPath.replace('.pdf', '')}"`);

        const generatedPath = pdfPath.replace('.pdf', '-1.png');
        if (fs.existsSync(generatedPath)) {
            fs.renameSync(generatedPath, imagePath);
        }

        return imagePath;
    } catch (error) {
        logger.error(`Error converting PDF to image: ${error.message}`);
        throw error;
    }
}

async function extractTextFromPDF(filePath) {
    try {
        const imagePath = await convertPDFToImage(filePath);

        const config = {
            lang: "eng",
            oem: 1,
            psm: 3,
            'tessdata-dir': '/usr/share/tesseract-ocr/4.00/tessdata',
            dpi: 300
        };

        logger.info(`Performing OCR on image: ${imagePath}`);
        const text = await tesseract.recognize(imagePath, config);
        logger.info('OCR completed successfully');

        fs.unlinkSync(imagePath);
        return text;
    } catch (error) {
        logger.error(`Error extracting text from PDF: ${error.message}`);
        throw error;
    }
}

function extractOrderNumber(text) {
    logger.info('Attempting to extract order number from text');

    // First, normalize dashes/hyphens in the text
    const normalizedText = text.replace(/[—–]/g, '-'); // Replace em dash and en dash with regular hyphen

    // Define order number prefixes for different formats
    const longPrefixes = ['EJR', 'EJC', 'MH'];  // For 6-digit numbers
    const shortPrefixes = ['R', 'AL'];  // For 4-digit numbers

    const longPrefixPattern = `(?:${longPrefixes.join('|')})`;
    const shortPrefixPattern = `(?:${shortPrefixes.join('|')})`;

    const patterns = [
        // 9-digit numbers with multiple segments (e.g., 000235334-1-3)
        /\b(\d{9}(?:\s*[—–-]\s*\d)+)\b/,

        // 2 + 9 digits format: 2000000289-1
        /\b(2\d{9}(?:-\d)?)\b/,

        // EL format with suffix: EL649453EL-1
        /\b(EL\d{6}EL(?:-\d)?)\b/i,

        // Short prefix formats: R3817-1, AL5862-1
        new RegExp(`\\b(${shortPrefixPattern}\\d{4}(?:-\\d)?)\\b`, 'i'),

        // Long prefix formats with 6 digits and optional -digit
        new RegExp(`\\b(${longPrefixPattern}\\d{6}(?:-\\d)?)\\b`, 'i'),

        // 9-digit numbers with optional -digit (with space before dash)
        /\b(\d{9}\s*-\s*\d)\b/,
        /\b(\d{9}(?:-\d)?)\b/,

        // 6-digit numbers with -digit (with space before dash)
        /\b(\d{6}\s*-\s*\d)\b/,
        /\b(\d{6}-\d)\b/,

        // Standalone patterns with surrounding characters
        /(?:^|\s|#)(EL\d{6}EL(?:-\d)?)/i,
        new RegExp(`(?:^|\\s|#)(${shortPrefixPattern}\\d{4}(?:-\\d)?)`, 'i'),
        new RegExp(`(?:^|\\s|#)(${longPrefixPattern}\\d{6}(?:-\\d)?)`, 'i'),

        // Look for order numbers with common labels
        new RegExp(`(?:Order\\s*#?\\s*|Order\\s*Number\\s*[:"']?\\s*)((?:${longPrefixPattern})?\\d{6,9}\\s*-?\\s*\\d?)`, 'i'),
        new RegExp(`(?:Order\\s*#?\\s*|Order\\s*Number\\s*[:"']?\\s*)((?:${shortPrefixPattern})?\\d{4}\\s*-?\\s*\\d?)`, 'i'),
        new RegExp(`(?:Order\\s*#?\\s*|Order\\s*Number\\s*[:"']?\\s*)(EL\\d{6}EL\\s*-?\\s*\\d?)`, 'i'),

        // Look for # followed by number patterns
        new RegExp(`#\\s*((?:${longPrefixPattern}|${shortPrefixPattern})?\\d{4,9}\\s*-?\\s*\\d?)`, 'i'),
        /#\s*(EL\d{6}EL\s*-?\s*\d?)/i
    ];

    let foundOrderNumber = null;
    let matchedPattern = null;

    for (const pattern of patterns) {
        const match = normalizedText.match(pattern);
        if (match) {
            foundOrderNumber = match[1] || match[0];
            matchedPattern = pattern.toString();

            // Clean up the order number
            foundOrderNumber = foundOrderNumber
                .trim()
                // Remove all spaces
                .replace(/\s+/g, '')
                // Normalize any remaining dashes
                .replace(/[—–]/g, '-');

            // Special handling for EL format
            if (foundOrderNumber.toUpperCase().startsWith('EL') &&
                foundOrderNumber.toUpperCase().includes('EL-')) {
                foundOrderNumber = foundOrderNumber.replace(/el/gi, 'EL');
            }
            // Normalize other prefixes
            else {
                for (const prefix of [...longPrefixes, ...shortPrefixes]) {
                    if (foundOrderNumber.toUpperCase().startsWith(prefix.toUpperCase())) {
                        foundOrderNumber = prefix + foundOrderNumber.slice(prefix.length);
                        break;
                    }
                }
            }

            // Validate the format
            const isValidFormat = (
                // 2 + 9 digits format: 2000000289-1
                /^2\d{9}(?:-\d)+$/.test(foundOrderNumber) ||
                // EL format: EL649453EL-1
                /^EL\d{6}EL(?:-\d)+$/i.test(foundOrderNumber) ||
                // Short prefix formats: R3817-1, AL5862-1
                shortPrefixes.some(prefix =>
                    new RegExp(`^${prefix}\\d{4}(?:-\\d)+$`, 'i').test(foundOrderNumber)
                ) ||
                // Long prefix formats: EJR123456-1, EJC123456-1, MH123456-1
                longPrefixes.some(prefix =>
                    new RegExp(`^${prefix}\\d{6}(?:-\\d)+$`, 'i').test(foundOrderNumber)
                ) ||
                // 9-digit format with optional dash: 000232569-1
                /^\d{9}(?:-\d)+$/.test(foundOrderNumber) ||
                // 6-digit format with dash: 123456-1
                /^\d{6}(?:-\d)+$/.test(foundOrderNumber)
            );

            if (isValidFormat) {
                logger.info(`Found order number: ${foundOrderNumber} (matched pattern: ${matchedPattern})`);
                return foundOrderNumber;
            } else {
                logger.info(`Found potential order number but invalid format: ${foundOrderNumber}`);
                continue;  // Try next pattern
            }
        }
    }

    // Log the failure to find an order number
    logger.error('No order number found. Text content:');
    logger.error('---Begin Text Content---');
    logger.error(normalizedText);
    logger.error('---End Text Content---');
    logger.error('Attempted patterns:');
    patterns.forEach(pattern => {
        logger.error(`- ${pattern.toString()}`);
    });

    return null;
}

function extractTrackingNumber(fileName, pdfText) {
    logger.info('Attempting to extract tracking number');

    // First try to extract from PDF text
    const patterns = [
        // // USPS tracking number format (20-22 digits, space or no space)
        // /\b(\d[\d\s]{19,21}\d)\b/,

        // More specific USPS format (9205 XXXX XXXX XXXX XXXX XX)
        /\b(9205\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{4}\s*\d{2})\b/
    ];

    let trackingNumber = null;
    // Try to find tracking number in PDF text first
    for (const pattern of patterns) {
        const match = pdfText.match(pattern);
        if (match) {
            // Clean up the tracking number (remove spaces)
            trackingNumber = (match[1] || match[0]).replace(/\s+/g, '');
            logger.info(`Found tracking number in PDF: ${trackingNumber}`);
            return trackingNumber;
        }
    }

    // If no tracking number found in PDF, fall back to filename
    if (!trackingNumber) {
        trackingNumber = path.basename(fileName, '.pdf');
        if (trackingNumber.match(/^\d{20,22}$/)) {
            logger.info(`Found tracking number in filename: ${trackingNumber}`);
            return trackingNumber;
        }
    }

    logger.error('No valid tracking number found in PDF or filename');
    return null;
}

async function processPDFFile(filePath) {
    try {
        logger.info(`Processing PDF: ${filePath}`);
        const text = await extractTextFromPDF(filePath);

        const orderNumber = extractOrderNumber(text);
        if (!orderNumber) {
            logger.error(`No order number found in PDF: ${filePath}`);
            return {
                fileName: path.basename(filePath),
                success: false,
                message: 'Order number not found in PDF'
            };
        }

        const trackingNumber = extractTrackingNumber(filePath, text);
        if (!trackingNumber) {
            logger.error(`No tracking number found in filename: ${filePath}`);
            return {
                fileName: path.basename(filePath),
                success: false,
                message: 'Tracking number not found'
            };
        }

        const result = await processOrder(orderNumber, trackingNumber);
        if (result.success) {
            logger.success(`Successfully processed order ${orderNumber} with tracking ${trackingNumber}`);
        } else {
            logger.error(`Failed to process order ${orderNumber}: ${result.message}`);
        }

        return {
            fileName: path.basename(filePath),
            success: result.success,
            message: result.message,
            orderNumber,
            trackingNumber
        };
    } catch (error) {
        logger.error(`Error processing file ${filePath}: ${error.message}`);
        return {
            fileName: path.basename(filePath),
            success: false,
            message: error.message
        };
    }
}

async function processDirectory(directoryPath) {
    try {
        const files = fs.readdirSync(directoryPath)
            .filter(file => file.toLowerCase().endsWith('.pdf'))
            .map(file => path.join(directoryPath, file));

        logger.info(`Found ${files.length} PDF files to process in ${directoryPath}`);
        const results = [];

        for (const file of files) {
            logger.info(`\nProcessing file: ${path.basename(file)}`);
            const result = await processPDFFile(file);
            results.push(result);
        }

        // Generate summary at the end
        logger.summary(results);

    } catch (error) {
        logger.error(`Error processing directory: ${error.message}`);
    }
}

// Check if being run directly
if (import.meta.url === `file://${process.argv[1]}`) {
    const directoryPath = process.argv[2] || '.';
    if (!directoryPath) {
        logger.error('Please provide a directory path');
        process.exit(1);
    }

    logger.info(`Starting PDF processing in directory: ${directoryPath}`);
    processDirectory(directoryPath);
}

export {
    processPDFFile,
    processDirectory
};