const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const https = require('https');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();

// HTTPS Configuration
let server;
let httpsOptions = {};

if (process.env.NODE_ENV === 'production') {
  // Production HTTPS configuration
  try {
    httpsOptions = {
      key: fs.readFileSync(process.env.SSL_KEY_PATH || '/path/to/your/private-key.pem'),
      cert: fs.readFileSync(process.env.SSL_CERT_PATH || '/path/to/your/certificate.pem'),
      // Optional: Add intermediate certificate if you have one
      // ca: fs.readFileSync(process.env.SSL_CA_PATH || '/path/to/your/ca-bundle.pem')
    };
    server = https.createServer(httpsOptions, app);
    console.log('HTTPS server configured for production');
  } catch (error) {
    console.error('Error loading SSL certificates:', error);
    console.log('Falling back to HTTP server');
    server = http.createServer(app);
  }
} else {
  // Development: Use HTTP or self-signed certificates
  if (process.env.USE_HTTPS_DEV === 'true') {
    try {
      // Generate self-signed certificates for development
      // You can create these using: openssl req -x509 -newkey rsa:4096 -keyout dev-key.pem -out dev-cert.pem -days 365 -nodes
      httpsOptions = {
        key: fs.readFileSync(path.join(__dirname, 'certs', 'dev-key.pem')),
        cert: fs.readFileSync(path.join(__dirname, 'certs', 'dev-cert.pem'))
      };
      server = https.createServer(httpsOptions, app);
      console.log('HTTPS server configured for development with self-signed certificates');
    } catch (error) {
      console.log('Self-signed certificates not found, using HTTP for development');
      server = http.createServer(app);
    }
  } else {
    server = http.createServer(app);
  }
}

// CORS configuration - Updated for HTTPS
const corsOptions = {
  origin: [
    "https://chatriox.com", "https://www.chatriox.com"
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-client-id', 'x-client-secret']
};

// Enhanced security middleware for HTTPS
app.use(cors(corsOptions));
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https:"],
      scriptSrc: ["'self'", "https:"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https:", "wss:"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      mediaSrc: ["'self'"],
      frameSrc: ["'none'"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// Force HTTPS in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.header('x-forwarded-proto') !== 'https') {
      res.redirect(`https://${req.header('host')}${req.url}`);
    } else {
      next();
    }
  });
}

app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/marketing_dashboard', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected successfully'))
.catch(err => console.error('MongoDB connection error:', err));

// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/email', require('./routes/email'));
app.use('/api/analysis', require('./routes/analysis'));
app.use('/api/gmail', require('./routes/gmail'));
app.use('/api/validation', require('./routes/validation'));
app.use('/api/scraper', require('./routes/scraper'));
app.use('/api/accounts', require('./routes/accounts'));
app.use('/api/plans', require('./routes/plans'));
app.use('/api/settings', require('./routes/settings'));
app.use('/api/users', require('./routes/users'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/smtp', require('./routes/smtp'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/campaigns', require('./routes/campaigns'));
app.use('/api/email-tracking', require('./routes/email-tracking'));
app.use('/api/whatsapp-web', require('./routes/whatsapp-web'));
app.use('/api/subscription', require('./routes/payments'));
app.use('/api/templates', require('./routes/email-templates'));
app.use('/api/ai', require('./routes/ai'));

// Template usage tracking middleware
const trackTemplateUsage = async (req, res, next) => {
  try {
    if (req.user && req.method === 'POST' && req.path.includes('/templates')) {
      // Increment user's template count
      await User.findByIdAndUpdate(req.user.id, {
        $inc: { 'stats.totalTemplates': 1 }
      });
    }
    next();
  } catch (error) {
    console.error('Template usage tracking error:', error);
    next();
  }
};

// Apply template usage tracking middleware
app.use('/api/templates', trackTemplateUsage);

// Enhanced email validation for templates
const validateEmailContent = (req, res, next) => {
  const { htmlContent } = req.body;
  
  if (htmlContent) {
    // Basic HTML validation
    const hasValidStructure = htmlContent.includes('<html') || htmlContent.includes('<body');
    const hasSuspiciousContent = /<script|javascript:|vbscript:|onload|onerror/i.test(htmlContent);
    
    if (hasSuspiciousContent) {
      return res.status(400).json({
        success: false,
        message: 'Template contains potentially harmful content'
      });
    }
    
    // Add email-safe CSS validation
    if (htmlContent.includes('position:fixed') || htmlContent.includes('position:sticky')) {
      req.body.htmlContent = htmlContent.replace(/(position:\s*(fixed|sticky))/gi, 'position:relative');
    }
  }
  
  next();
};

// Apply email content validation
app.use('/api/templates', validateEmailContent);

// Template backup and versioning
const createTemplateBackup = async (templateId, userId) => {
  try {
    const Template = require('./models/Template');
    const template = await Template.findById(templateId);
    
    if (template) {
      const backupData = {
        ...template.toObject(),
        originalId: template._id,
        backupDate: new Date(),
        userId: userId
      };
      
      // Store in a separate collection or file system
      // This is a simplified example - you might want to use a separate BackupTemplate model
      console.log('Template backup created for template:', templateId);
      
      return backupData;
    }
  } catch (error) {
    console.error('Template backup error:', error);
  }
};

// Export the backup function for use in routes
module.exports = { createTemplateBackup };

// Add rate limiting specifically for AI template generation
const aiGenerationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: (req) => {
    // Different limits based on user subscription
    if (req.user) {
      switch (req.user.subscription?.plan) {
        case 'premium': return 50;
        case 'basic': return 20;
        default: return 5;
      }
    }
    return 3; // For non-authenticated requests
  },
  message: {
    success: false,
    message: 'AI generation limit exceeded. Please try again later or upgrade your plan.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply AI generation rate limiting
app.use('/api/templates/ai-generate', aiGenerationLimiter);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    protocol: req.protocol,
    secure: req.secure
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

const PORT = process.env.PORT || 5000;
const HTTPS_PORT = process.env.HTTPS_PORT || 443;

// Initialize Socket.IO with HTTPS support
const io = socketIo(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
['https://chatriox.com', "https://www.chatriox.com"] ,

    credentials: true
  }
});

// Make io globally available
global.io = io;

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('join_user_room', (userId) => {
    socket.join(`user_${userId}`);
    console.log(`User ${userId} joined room`);
  });
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start server
const actualPort = process.env.NODE_ENV === 'production' 
  ? (server instanceof https.Server ? HTTPS_PORT : PORT)
  : PORT;

server.listen(actualPort, () => {
  const protocol = server instanceof https.Server ? 'https' : 'http';
  console.log(`Server running on ${protocol}://localhost:${actualPort}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Protocol: ${protocol.toUpperCase()}`);
  console.log(`MongoDB URI: ${process.env.MONGODB_URI || 'mongodb://localhost:27017/marketing_dashboard'}`);
});

module.exports = app;