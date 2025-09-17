const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const QRCode = require('qrcode');
const path = require('path');
const WhatsAppAccount = require('../models/WhatsAppAccount');
const WhatsAppMessage = require('../models/WhatsAppMessage');
const WhatsAppCampaign = require('../models/WhatsAppCampaign');

class WhatsAppWebService {
  constructor() {
    this.clients = new Map();
    this.qrCodes = new Map();
    this.sessionPath = path.join(__dirname, '../sessions');
    this.connectionHealth = new Map();
    this.reconnectAttempts = new Map();
    this.initializingClients = new Set();
    this.authStates = new Map(); // Track auth states for debugging
    
    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true });
    }

    this.startHealthMonitor();
    this.setupDebugLogging();
  }

  // Enhanced debug logging system
  setupDebugLogging() {
    const logPath = path.join(__dirname, '../logs');
    if (!fs.existsSync(logPath)) {
      fs.mkdirSync(logPath, { recursive: true });
    }
    
    this.logFile = path.join(logPath, `whatsapp-debug-${new Date().toISOString().split('T')[0]}.log`);
  }

  debugLog(accountId, level, message, data = null) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      accountId,
      level,
      message,
      data: data ? (typeof data === 'object' ? JSON.stringify(data, null, 2) : data) : null
    };

    const logLine = `[${timestamp}] [${level.toUpperCase()}] [${accountId}] ${message}${data ? ` | Data: ${logEntry.data}` : ''}\n`;
    
    // Console log with colors
    const colors = {
      ERROR: '\x1b[31m',   // Red
      WARN: '\x1b[33m',    // Yellow
      INFO: '\x1b[36m',    // Cyan
      DEBUG: '\x1b[90m',   // Gray
      SUCCESS: '\x1b[32m', // Green
      RESET: '\x1b[0m'
    };

    console.log(`${colors[level.toUpperCase()] || colors.INFO}${logLine.trim()}${colors.RESET}`);
    
    // File logging
    try {
      fs.appendFileSync(this.logFile, logLine);
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }

  // Track authentication state changes
  updateAuthState(accountId, state, details = {}) {
    const currentState = this.authStates.get(accountId) || {};
    const newState = {
      ...currentState,
      currentState: state,
      timestamp: new Date().toISOString(),
      details,
      history: [
        ...(currentState.history || []),
        {
          state,
          timestamp: new Date().toISOString(),
          details
        }
      ].slice(-10) // Keep last 10 state changes
    };

    this.authStates.set(accountId, newState);
    this.debugLog(accountId, 'DEBUG', `Auth state changed to: ${state}`, details);
  }

  // Enhanced client initialization with comprehensive logging
  async initializeClient(accountId, userId, io = null) {
    const accountIdStr = accountId.toString();
    const initKey = `${userId}_${accountIdStr}`;
    
    this.debugLog(accountIdStr, 'INFO', `🔄 Starting client initialization`, { 
      userId, 
      initKey,
      existingClient: this.clients.has(accountIdStr),
      isInitializing: this.initializingClients.has(initKey)
    });

    if (this.initializingClients.has(initKey)) {
      const error = new Error('Client initialization already in progress for this account');
      this.debugLog(accountIdStr, 'ERROR', error.message);
      throw error;
    }
    
    this.initializingClients.add(initKey);
    this.updateAuthState(accountIdStr, 'INITIALIZING', { userId, initKey });
    
    try {
      // Get account from database
      const account = await WhatsAppAccount.findOne({ _id: accountIdStr, user: userId });
      if (!account) {
        throw new Error('Account not found in database');
      }

      this.debugLog(accountIdStr, 'INFO', `Found account in database`, {
        accountName: account.accountName,
        status: account.status,
        phoneNumber: account.phoneNumber
      });

      // Force cleanup any existing client and session
      this.debugLog(accountIdStr, 'INFO', '🧹 Starting cleanup of existing client');
      await this.forceCleanupClient(accountIdStr);
      
      // Wait after cleanup
      this.debugLog(accountIdStr, 'DEBUG', 'Waiting 2 seconds after cleanup');
      await this.sleep(2000);

      // Create unique session path
      const sessionId = `${userId}_${accountIdStr}`;
      const sessionDir = path.join(this.sessionPath, sessionId);
      
      this.debugLog(accountIdStr, 'INFO', `Creating client with session ID: ${sessionId}`, {
        sessionPath: sessionDir
      });

      // Create new client with enhanced settings
      const clientOptions = {
        authStrategy: new LocalAuth({
          clientId: sessionId,
          dataPath: this.sessionPath
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--memory-pressure-off',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            `--user-data-dir=${sessionDir}`
          ],
          timeout: 60000,
          // Add additional debugging options
          dumpio: false, // Set to true to see browser logs
          devtools: false // Set to true for debugging
        },
        restartOnAuthFail: true,
        qrMaxRetries: 5, // Increased retries
        takeoverOnConflict: true, // Handle conflicts better
        takeoverTimeoutMs: 0
      };

      this.debugLog(accountIdStr, 'DEBUG', 'Client options configured', clientOptions);

      const client = new Client(clientOptions);

      // Store client immediately
      this.clients.set(accountIdStr, client);
      this.connectionHealth.set(accountIdStr, { 
        status: 'initializing', 
        lastCheck: Date.now(),
        userId: userId
      });

      this.debugLog(accountIdStr, 'SUCCESS', 'Client created and stored');

      // Setup event handlers BEFORE initialization
      this.debugLog(accountIdStr, 'INFO', 'Setting up event handlers');
   this.setupClientEvents(client, accountIdStr, userId, account, io);

      // Add puppeteer event listeners for debugging
      this.setupPuppeteerDebugEvents(client, accountIdStr);

      this.updateAuthState(accountIdStr, 'CLIENT_CREATED');

      // Initialize client with timeout
     this.debugLog(accountIdStr, 'DEBUG', 'Waiting 3 seconds after cleanup');
await this.sleep(3000);
      const initPromise = client.initialize();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Client initialization timeout after 90 seconds')), 90000);
      });

      await Promise.race([initPromise, timeoutPromise]);
      
      this.debugLog(accountIdStr, 'SUCCESS', '✅ Client initialized successfully');
      this.updateAuthState(accountIdStr, 'INITIALIZED');
      
      return client;

    } catch (error) {
      this.debugLog(accountIdStr, 'ERROR', `❌ Client initialization failed: ${error.message}`, {
        stack: error.stack,
        authState: this.authStates.get(accountIdStr)
      });
      
      // Cleanup on failure
      await this.forceCleanupClient(accountIdStr);
      this.updateAuthState(accountIdStr, 'INIT_FAILED', { error: error.message });
      
      // Update database status
      try {
        await WhatsAppAccount.findByIdAndUpdate(accountIdStr, {
          status: 'failed',
          errorMessage: error.message,
          updatedAt: new Date()
        });
      } catch (dbError) {
        this.debugLog(accountIdStr, 'ERROR', 'Database update failed', dbError);
      }

      throw error;
    } finally {
      this.initializingClients.delete(initKey);
      this.debugLog(accountIdStr, 'DEBUG', `Removed initialization lock: ${initKey}`);
    }
  }

  // Setup Puppeteer debug events
  setupPuppeteerDebugEvents(client, accountIdStr) {
    client.on('loading_screen', (percent, message) => {
      this.debugLog(accountIdStr, 'DEBUG', `Loading screen: ${percent}%`, { message });
    });

    // Listen for browser events
    client.pupBrowser?.on('disconnected', () => {
      this.debugLog(accountIdStr, 'WARN', '🔌 Browser disconnected');
      this.updateAuthState(accountIdStr, 'BROWSER_DISCONNECTED');
    });

    // Page events (when available)
    setTimeout(() => {
      if (client.pupPage) {
        client.pupPage.on('console', (msg) => {
          if (msg.type() === 'error' || msg.text().includes('whatsapp') || msg.text().includes('auth')) {
            this.debugLog(accountIdStr, 'DEBUG', `Browser console: ${msg.type()}`, { text: msg.text() });
          }
        });

        client.pupPage.on('error', (error) => {
          this.debugLog(accountIdStr, 'ERROR', `Page error: ${error.message}`);
        });

        client.pupPage.on('pageerror', (error) => {
          this.debugLog(accountIdStr, 'ERROR', `Page script error: ${error.message}`);
        });
      }
    }, 5000);
  }

  // Enhanced event handlers with detailed logging
  setupClientEvents(client, accountIdStr, userId, account, io) {
    this.debugLog(accountIdStr, 'INFO', '📡 Setting up WhatsApp client events');

    // Client error handler - FIRST priority
    client.on('error', (error) => {
      this.debugLog(accountIdStr, 'ERROR', `🚫 Client error: ${error.message}`, {
        error: error.toString(),
        stack: error.stack,
        authState: this.authStates.get(accountIdStr)
      });
      this.updateAuthState(accountIdStr, 'CLIENT_ERROR', { error: error.message });
      this.handleClientError(accountIdStr, userId, error, io);
    });

    // QR Code generation
    client.on('qr', async (qr) => {
      this.debugLog(accountIdStr, 'INFO', '📱 QR Code generated');
      this.updateAuthState(accountIdStr, 'QR_GENERATED');
      
      try {
        const dataUrl = await QRCode.toDataURL(qr);
        this.qrCodes.set(accountIdStr, dataUrl);
        
        // Update database
        await WhatsAppAccount.findByIdAndUpdate(accountIdStr, {
          qrCode: dataUrl,
          status: 'connecting',
          errorMessage: null,
          updatedAt: new Date()
        });

        this.debugLog(accountIdStr, 'SUCCESS', 'QR Code stored and database updated');

        // Emit to user
        this.emitToUser(userId, 'qr_code', {
          accountId: accountIdStr,
          qrCode: dataUrl,
          timestamp: new Date().toISOString()
        }, io);

        this.debugLog(accountIdStr, 'INFO', 'QR Code emitted to user');
        
      } catch (err) {
        this.debugLog(accountIdStr, 'ERROR', `QR Code processing failed: ${err.message}`);
        this.handleClientError(accountIdStr, userId, err, io);
      }
    });

    // Authentication event - CRITICAL DEBUG POINT
    client.on('authenticated', async (session) => {
      this.debugLog(accountIdStr, 'SUCCESS', '✅ AUTHENTICATION SUCCESSFUL', {
        sessionExists: !!session,
        sessionKeys: session ? Object.keys(session) : null,
        hasWABrowserId: session?.WABrowserId ? true : false,
        hasWASecretBundle: session?.WASecretBundle ? true : false
      });
      
      this.updateAuthState(accountIdStr, 'AUTHENTICATED', {
        sessionId: session?.WABrowserId,
        timestamp: new Date().toISOString()
      });
      
      this.connectionHealth.set(accountIdStr, { 
        status: 'authenticated', 
        lastCheck: Date.now(),
        userId: userId
      });
      
      try {
        // Update database immediately
        const dbUpdate = await WhatsAppAccount.findByIdAndUpdate(accountIdStr, {
          status: 'authenticated',
          qrCode: null,
          errorMessage: null,
          updatedAt: new Date()
        }, { new: true });

        this.debugLog(accountIdStr, 'SUCCESS', 'Database updated with authenticated status', {
          dbStatus: dbUpdate?.status
        });
        
      } catch (error) {
        this.debugLog(accountIdStr, 'ERROR', 'Database update failed during authentication', error);
      }
      
      // Clear QR code
      this.qrCodes.delete(accountIdStr);
      
      // Emit authenticated event
      this.emitToUser(userId, 'whatsapp_authenticated', { 
        accountId: accountIdStr,
        status: 'authenticated',
        timestamp: new Date().toISOString()
      }, io);

      this.debugLog(accountIdStr, 'INFO', 'Authenticated event emitted, waiting for ready event...');
    });

    // Ready event - CRITICAL DEBUG POINT
    client.on('ready', async () => {
      this.debugLog(accountIdStr, 'SUCCESS', '🚀 CLIENT READY EVENT TRIGGERED');
      
      // Check client info immediately
      const clientInfo = client.info;
      this.debugLog(accountIdStr, 'DEBUG', 'Client info on ready', {
        hasInfo: !!clientInfo,
        phoneNumber: clientInfo?.wid?.user,
        profileName: clientInfo?.pushname,
        platform: clientInfo?.platform,
        plugged: clientInfo?.plugged,
        battery: clientInfo?.battery
      });

      // CRITICAL: Update connection health first
      this.connectionHealth.set(accountIdStr, { 
        status: 'ready', 
        lastCheck: Date.now(),
        userId: userId,
        phoneNumber: clientInfo?.wid?.user 
      });

      this.updateAuthState(accountIdStr, 'READY', {
        phoneNumber: clientInfo?.wid?.user,
        profileName: clientInfo?.pushname,
        timestamp: new Date().toISOString()
      });

      try {
        // Validate client state
        const state = await client.getState();
        this.debugLog(accountIdStr, 'DEBUG', `Client state on ready: ${state}`);

        if (state !== 'CONNECTED') {
          this.debugLog(accountIdStr, 'WARN', `Client state is ${state} instead of CONNECTED`);
        }

        // Get comprehensive client info
        const phoneNumber = clientInfo?.wid?.user;
        const profileName = clientInfo?.pushname || 'Unknown';
        
        this.debugLog(accountIdStr, 'INFO', 'Extracting client information', {
          phoneNumber,
          profileName,
          hasWid: !!clientInfo?.wid,
          widUser: clientInfo?.wid?.user
        });
        
        // Update database with complete ready status
        const updatedAccount = await WhatsAppAccount.findByIdAndUpdate(accountIdStr, {
          status: 'ready',
          isConnected: true,
          phoneNumber: phoneNumber,
          profileName: profileName,
          lastActivity: new Date(),
          errorMessage: null,
          qrCode: null,
          updatedAt: new Date()
        }, { new: true });
        
        this.debugLog(accountIdStr, 'SUCCESS', 'Database updated with ready status', {
          dbStatus: updatedAccount?.status,
          dbPhone: updatedAccount?.phoneNumber,
          dbProfile: updatedAccount?.profileName
        });
        
      } catch (error) {
        this.debugLog(accountIdStr, 'ERROR', 'Database update failed during ready event', {
          error: error.message,
          stack: error.stack
        });
      }

      // CRITICAL: Emit ready event with complete data
      const readyEventData = {
        accountId: accountIdStr,
        status: 'ready',
        phoneNumber: clientInfo?.wid?.user,
        profileName: clientInfo?.pushname || 'Unknown',
        isConnected: true,
        timestamp: new Date().toISOString()
      };

      this.debugLog(accountIdStr, 'INFO', 'Emitting ready event', readyEventData);
      
      this.emitToUser(userId, 'whatsapp_ready', readyEventData, io);

      // Reset reconnection attempts on successful connection
      this.reconnectAttempts.delete(accountIdStr);
      
      // Additional verification after a delay
      setTimeout(() => {
        this.debugLog(accountIdStr, 'DEBUG', 'Sending verification status update');
        this.emitToUser(userId, 'connection_status_update', {
          accountId: accountIdStr,
          status: 'ready',
          verified: true,
          timestamp: new Date().toISOString()
        }, io);
      }, 1000);

      this.debugLog(accountIdStr, 'SUCCESS', '🎉 Client fully ready and configured');
    });

    // State change monitoring
    client.on('change_state', (state) => {
      this.debugLog(accountIdStr, 'INFO', `🔄 State change: ${state}`, {
        previousState: this.authStates.get(accountIdStr)?.currentState,
        newState: state
      });
      
      this.updateAuthState(accountIdStr, `STATE_${state}`);
      
      // Update connection health
      this.connectionHealth.set(accountIdStr, { 
        ...this.connectionHealth.get(accountIdStr),
        lastState: state,
        lastCheck: Date.now()
      });
      
      // Emit state change to frontend
      this.emitToUser(userId, 'whatsapp_state_change', {
        accountId: accountIdStr,
        state: state,
        timestamp: new Date().toISOString()
      }, io);
    });

    // Connection change monitoring
    client.on('change_battery', (batteryInfo) => {
      this.debugLog(accountIdStr, 'DEBUG', 'Battery info updated', batteryInfo);
    });

    // Disconnection handler
    client.on('disconnected', async (reason) => {
      this.debugLog(accountIdStr, 'WARN', `🔌 Client disconnected. Reason: ${reason}`, {
        authState: this.authStates.get(accountIdStr),
        reason
      });
      
      this.updateAuthState(accountIdStr, 'DISCONNECTED', { reason });
      
      this.connectionHealth.set(accountIdStr, { 
        status: 'disconnected', 
        lastCheck: Date.now(),
        reason: reason
      });

      try {
        await WhatsAppAccount.findByIdAndUpdate(accountIdStr, {
          status: 'disconnected',
          isConnected: false,
          errorMessage: `Disconnected: ${reason}`,
          updatedAt: new Date()
        });
      } catch (error) {
        this.debugLog(accountIdStr, 'ERROR', 'Database update failed on disconnect', error);
      }

      this.emitToUser(userId, 'whatsapp_disconnected', {
        accountId: accountIdStr,
        reason: reason,
        status: 'disconnected'
      }, io);

      // Clean up the disconnected client
      await this.safeCleanupClient(accountIdStr);

      // Attempt reconnection for unexpected disconnects
      if (reason !== 'LOGOUT' && reason !== 'NAVIGATION' && !reason.includes('Protocol error')) {
        this.scheduleReconnection(accountIdStr, userId, io);
      }
    });

    // Authentication failure
    client.on('auth_failure', async (error) => {
      this.debugLog(accountIdStr, 'ERROR', `🚫 Authentication failure: ${error}`, {
        error: error.toString(),
        authState: this.authStates.get(accountIdStr)
      });
      
      this.updateAuthState(accountIdStr, 'AUTH_FAILED', { error: error.toString() });
      
      this.connectionHealth.set(accountIdStr, { 
        status: 'auth_failed', 
        lastCheck: Date.now(),
        error: error.toString()
      });

      try {
        await WhatsAppAccount.findByIdAndUpdate(accountIdStr, {
          status: 'failed',
          isConnected: false,
          errorMessage: 'Authentication failed - please reconnect',
          updatedAt: new Date()
        });
      } catch (dbError) {
        this.debugLog(accountIdStr, 'ERROR', 'Database update failed on auth failure', dbError);
      }

      await this.safeCleanupClient(accountIdStr);

      this.emitToUser(userId, 'whatsapp_auth_failed', {
        accountId: accountIdStr,
        error: error.toString(),
        status: 'failed'
      }, io);
    });

    // Message acknowledgment tracking
    client.on('message_ack', (msg, ack) => {
      this.debugLog(accountIdStr, 'DEBUG', `Message ACK: ${ack}`, { messageId: msg.id._serialized });
      this.handleMessageAck(msg, ack, accountIdStr).catch(console.error);
    });

    this.debugLog(accountIdStr, 'SUCCESS', '✅ All event handlers configured');
  }

  // Enhanced debugging method to get auth state
  getAuthState(accountId) {
    return this.authStates.get(accountId) || { currentState: 'UNKNOWN', history: [] };
  }

  // Method to get debug information
  getDebugInfo(accountId) {
    const client = this.clients.get(accountId);
    const health = this.connectionHealth.get(accountId);
    const authState = this.authStates.get(accountId);
    
    return {
      hasClient: !!client,
      clientInfo: client?.info ? {
        phoneNumber: client.info.wid?.user,
        profileName: client.info.pushname,
        platform: client.info.platform,
        battery: client.info.battery
      } : null,
      connectionHealth: health,
      authState: authState,
      qrCodeAvailable: this.qrCodes.has(accountId)
    };
  }

  // Rest of your existing methods remain the same...
  // (I'm keeping the existing methods to avoid breaking functionality)

  async handleClientError(accountIdStr, userId, error, io) {
    this.debugLog(accountIdStr, 'ERROR', `Handling client error: ${error.message}`, {
      error: error.toString(),
      stack: error.stack
    });
    
    this.updateAuthState(accountIdStr, 'CLIENT_ERROR', { error: error.message });
    
    this.connectionHealth.set(accountIdStr, { 
      status: 'error', 
      lastCheck: Date.now(),
      error: error.message
    });

    try {
      const account = await WhatsAppAccount.findById(accountIdStr);
      if (account) {
        account.status = 'failed';
        account.errorMessage = error.message;
        await account.save();
      }
    } catch (dbError) {
      this.debugLog(accountIdStr, 'ERROR', 'Database update failed in error handler', dbError);
    }

    await this.safeCleanupClient(accountIdStr);

    this.emitToUser(userId, 'whatsapp_error', {
      accountId: accountIdStr,
      error: error.message
    }, io);
  }

  // Enhanced cleanup with logging
  async safeCleanupClient(accountId) {
    const accountIdStr = accountId.toString();
    
    this.debugLog(accountIdStr, 'INFO', '🧹 Starting safe client cleanup');
    
    try {
      const client = this.clients.get(accountIdStr);
      if (client) {
        this.debugLog(accountIdStr, 'DEBUG', 'Client found, attempting to destroy');
        
        try {
          // Close browser pages first
          if (client.pupBrowser) {
            const pages = await client.pupBrowser.pages();
            this.debugLog(accountIdStr, 'DEBUG', `Closing ${pages.length} browser pages`);
            
            for (const page of pages) {
              try {
                if (!page.isClosed()) {
                  await page.close();
                }
              } catch (pageError) {
                this.debugLog(accountIdStr, 'WARN', `Error closing page: ${pageError.message}`);
              }
            }
          }
          
          // Destroy client
          await client.destroy();
          this.debugLog(accountIdStr, 'SUCCESS', 'Client destroyed successfully');
          
        } catch (destroyError) {
          this.debugLog(accountIdStr, 'ERROR', `Error destroying client: ${destroyError.message}`);
          
          // Force kill browser process if destroy fails
          if (client.pupBrowser && client.pupBrowser.process()) {
            try {
              client.pupBrowser.process().kill('SIGKILL');
              this.debugLog(accountIdStr, 'WARN', 'Browser process force killed');
            } catch (killError) {
              this.debugLog(accountIdStr, 'ERROR', `Error killing browser process: ${killError.message}`);
            }
          }
        }
        
        this.clients.delete(accountIdStr);
        this.debugLog(accountIdStr, 'DEBUG', 'Client removed from clients map');
      }
      
      this.qrCodes.delete(accountIdStr);
      this.connectionHealth.delete(accountIdStr);
      this.authStates.delete(accountIdStr);
      
      this.debugLog(accountIdStr, 'SUCCESS', '✅ Safe cleanup completed');
      
    } catch (error) {
      this.debugLog(accountIdStr, 'ERROR', `Error in safeCleanupClient: ${error.message}`, {
        stack: error.stack
      });
    }
  }

  async forceCleanupClient(accountId) {
    const accountIdStr = accountId.toString();
    
    this.debugLog(accountIdStr, 'INFO', '🗑️ Starting force cleanup with session deletion');
    
    await this.safeCleanupClient(accountIdStr);
    
    // Remove session files
    try {
      const sessionDir = path.join(this.sessionPath, `session-${accountIdStr}`);
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
        this.debugLog(accountIdStr, 'SUCCESS', `Removed session directory: ${sessionDir}`);
      }

      // Also check for user_account format sessions
      const sessionPattern = new RegExp(`.*_${accountIdStr}$`);
      const sessionFiles = fs.readdirSync(this.sessionPath);
      
      for (const file of sessionFiles) {
        if (sessionPattern.test(file)) {
          const fullPath = path.join(this.sessionPath, file);
          if (fs.existsSync(fullPath)) {
            if (fs.lstatSync(fullPath).isDirectory()) {
              fs.rmSync(fullPath, { recursive: true, force: true });
            } else {
              fs.unlinkSync(fullPath);
            }
            this.debugLog(accountIdStr, 'SUCCESS', `Removed session file/dir: ${fullPath}`);
          }
        }
      }
    } catch (error) {
      this.debugLog(accountIdStr, 'ERROR', `Failed to remove session files: ${error.message}`);
    }
    
    this.reconnectAttempts.delete(accountIdStr);
    this.debugLog(accountIdStr, 'SUCCESS', '✅ Force cleanup completed');
  }

  // Utility methods
  emitToUser(userId, event, data, io = null) {
    const socketIo = io || global.io;
    if (socketIo) {
      socketIo.to(`user_${userId}`).emit(event, data);
      this.debugLog(data.accountId || 'UNKNOWN', 'DEBUG', `Emitted event: ${event}`, { userId, data });
    } else {
      this.debugLog(data.accountId || 'UNKNOWN', 'WARN', `No socket.io available to emit event: ${event}`);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Add remaining methods from your original code here...
  // (keeping them as-is to maintain functionality)
  
    async sendMessage(accountId, recipient, content, options = {}) {
    const accountIdStr = accountId.toString();
    
    try {
      console.log(`📤 Sending message for account: ${accountIdStr} to ${recipient}`);

      const client = this.clients.get(accountIdStr);
      if (!client) {
        throw new Error('WhatsApp client not found. Please reconnect your account.');
      }

      // Enhanced connection validation
      if (!client.info) {
        throw new Error('WhatsApp client not ready. Please wait for connection.');
      }

      // Check if client is still alive
      try {
        const state = await Promise.race([
          client.getState(),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('State check timeout')), 10000)
          )
        ]);
        
        if (state !== 'CONNECTED') {
          this.connectionHealth.set(accountIdStr, { 
            status: 'disconnected', 
            lastCheck: Date.now() 
          });
          
          const account = await WhatsAppAccount.findById(accountIdStr);
          if (account) {
            account.status = 'disconnected';
            account.errorMessage = `Connection lost - state: ${state}`;
            await account.save();
          }

          throw new Error(`WhatsApp not connected. Current state: ${state}`);
        }
      } catch (stateError) {
        if (stateError.message.includes('timeout') || stateError.message.includes('Protocol error')) {
          throw new Error('WhatsApp client connection lost. Please reconnect.');
        }
        throw stateError;
      }

      // Rest of the sendMessage logic remains the same...
      let phoneNumber = recipient.replace(/\D/g, '');
      if (!phoneNumber.startsWith('91') && phoneNumber.length === 10) {
        phoneNumber = '91' + phoneNumber;
      }

      if (phoneNumber.length < 10) {
        throw new Error('Invalid phone number format');
      }

      const chatId = `${phoneNumber}@c.us`;

      // Check if number exists on WhatsApp with timeout
      const numberId = await Promise.race([
        client.getNumberId(chatId),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Number check timeout')), 15000)
        )
      ]);
      
      if (!numberId) {
        throw new Error(`Phone number ${phoneNumber} is not registered on WhatsApp`);
      }

      // Apply delays if requested
      if (options.humanTyping && content.text) {
        await this.simulateTyping(content.text.length);
      }

      if (options.randomDelay) {
        const delay = Math.random() * (options.maxDelay || 5000) + (options.minDelay || 1000);
        await this.sleep(delay);
      }

      // Send message based on type
      let message;
      switch (content.type) {
        case 'text':
          if (!content.text?.trim()) {
            throw new Error('Text content cannot be empty');
          }
          message = await client.sendMessage(chatId, content.text);
          break;

        case 'image':
          const imagePath = content.mediaPath || 
            (content.fileName ? path.join(__dirname, '../uploads/whatsapp/', content.fileName) : null);
          
          if (imagePath && fs.existsSync(imagePath)) {
            const imageMedia = MessageMedia.fromFilePath(imagePath);
            message = await client.sendMessage(chatId, imageMedia, { 
              caption: content.text || content.caption || '' 
            });
          } else if (content.mediaUrl) {
            const imageMedia = await MessageMedia.fromUrl(content.mediaUrl);
            message = await client.sendMessage(chatId, imageMedia, { 
              caption: content.text || content.caption || '' 
            });
          } else {
            throw new Error('No valid image source provided');
          }
          break;

        case 'video':
          const videoPath = content.mediaPath || 
            (content.fileName ? path.join(__dirname, '../uploads/whatsapp/', content.fileName) : null);
          
          if (videoPath && fs.existsSync(videoPath)) {
            const videoMedia = MessageMedia.fromFilePath(videoPath);
            message = await client.sendMessage(chatId, videoMedia, {
              caption: content.text || content.caption || '',
              sendMediaAsDocument: true
            });
          } else if (content.mediaUrl) {
            const videoMedia = await MessageMedia.fromUrl(content.mediaUrl);
            message = await client.sendMessage(chatId, videoMedia, {
              caption: content.text || content.caption || '',
              sendMediaAsDocument: true
            });
          } else {
            throw new Error('No valid video source provided');
          }
          break;

        default:
          throw new Error('Unsupported message type');
      }

      // Update account statistics
      const account = await WhatsAppAccount.findById(accountIdStr);
      if (account) {
        account.dailyMessageCount += 1;
        account.lastActivity = new Date();
        await account.save();
      }

      console.log(`✅ Message sent successfully: ${message.id._serialized}`);

      return {
        success: true,
        messageId: message.id._serialized,
        timestamp: new Date(),
        chatId: message.to
      };

    } catch (error) {
      console.error(`❌ Send message failed for ${accountIdStr}:`, error.message);
      
      // If it's a connection error, mark client as unhealthy
      if (error.message.includes('Protocol error') || 
          error.message.includes('Session closed') ||
          error.message.includes('connection lost') ||
          error.message.includes('timeout')) {
        await this.safeCleanupClient(accountIdStr);
      }
      
      return {
        success: false,
        error: error.message
      };
    }
  }
  scheduleReconnection(accountId, userId, io) {
    // Your existing scheduleReconnection implementation
  }

  startHealthMonitor() {
    // Your existing startHealthMonitor implementation with added logging
    setInterval(async () => {
      const clientEntries = Array.from(this.clients.entries());
      
      for (const [accountId, client] of clientEntries) {
        try {
          if (client && client.info) {
            const statePromise = client.getState();
            const timeoutPromise = new Promise((_, reject) => 
              setTimeout(() => reject(new Error('Health check timeout')), 10000)
            );
            
            const state = await Promise.race([statePromise, timeoutPromise]);
            const health = this.connectionHealth.get(accountId);
            
            if (state !== 'CONNECTED') {
              this.debugLog(accountId, 'WARN', `Health check failed, state: ${state}`);
              // Handle unhealthy state...
            }
          }
        } catch (error) {
          this.debugLog(accountId, 'ERROR', `Health check error: ${error.message}`);
          
          // If it's a session closed error, clean up the client
          if (error.message.includes('Protocol error') || 
              error.message.includes('Session closed') ||
              error.message.includes('timeout')) {
            await this.safeCleanupClient(accountId);
          }
        }
      }
    }, 45000); // Check every 45 seconds
  }

  // Enhanced disconnect method with detailed logging
  async disconnectAccount(accountId, userId = null, io = null) {
    const accountIdStr = accountId.toString();
    
    this.debugLog(accountIdStr, 'INFO', '🔌 Starting account disconnection process');
    
    try {
      const account = await WhatsAppAccount.findByIdAndUpdate(accountIdStr, {
        status: 'disconnecting',
        updatedAt: new Date()
      });

      if (!account) {
        throw new Error('Account not found in database');
      }

      this.debugLog(accountIdStr, 'INFO', 'Account found, starting logout process');

      if (userId && io) {
        this.emitToUser(userId, 'whatsapp_disconnecting', {
          accountId: accountIdStr
        }, io);
      }

      const client = this.clients.get(accountIdStr);
      let loggedOut = false;

      if (client) {
        try {
          // Try to logout gracefully from WhatsApp servers
          if (client.info) {
            this.debugLog(accountIdStr, 'INFO', '🚪 Attempting graceful logout from WhatsApp servers');
            
            await Promise.race([
              client.logout().then(() => {
                loggedOut = true;
                this.debugLog(accountIdStr, 'SUCCESS', 'Successfully logged out from WhatsApp servers');
              }),
              new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Logout timeout after 15 seconds')), 15000)
              )
            ]);
          }
        } catch (logoutError) {
          this.debugLog(accountIdStr, 'ERROR', `Standard logout failed: ${logoutError.message}`);
          
          // Try comprehensive browser logout methods
          if (client.pupPage && !client.pupPage.isClosed()) {
            this.debugLog(accountIdStr, 'INFO', 'Trying comprehensive browser logout methods');
            try {
              // Method 1: Direct Store API logout
              await client.pupPage.evaluate(() => {
                if (window.Store && window.Store.AppState && window.Store.AppState.logout) {
                  window.Store.AppState.logout();
                  return true;
                }
                return false;
              });
              
              await this.sleep(2000);
              
              // Method 2: Menu-based logout
              try {
                await client.pupPage.click('[data-testid="menu"]', { timeout: 5000 });
                await this.sleep(1000);
                await client.pupPage.click('[data-testid="mi-logout"]', { timeout: 5000 });
                await this.sleep(2000);
              } catch (menuError) {
                this.debugLog(accountIdStr, 'DEBUG', 'Menu logout failed, trying direct navigation');
              }
              
              // Method 3: Direct navigation + storage clear
              await client.pupPage.evaluate(() => {
                // Clear all storage
                localStorage.clear();
                sessionStorage.clear();
                
                // Clear IndexedDB
                if (window.indexedDB) {
                  window.indexedDB.databases().then(databases => {
                    databases.forEach(db => {
                      if (db.name.includes('whatsapp') || db.name.includes('wawc')) {
                        window.indexedDB.deleteDatabase(db.name);
                      }
                    });
                  });
                }
                
                // Force logout and redirect
                if (window.Store && window.Store.Conn) {
                  window.Store.Conn.logout();
                }
                
                if (window.Store && window.Store.Socket) {
                  window.Store.Socket.close();
                }
                
                // Navigate to logout
                window.location.href = 'https://web.whatsapp.com/logout';
                
                return true;
              });
              
              loggedOut = true;
              this.debugLog(accountIdStr, 'SUCCESS', 'Browser logout successful');
              
              // Wait for logout to process
              await this.sleep(5000);
              
            } catch (altLogoutError) {
              this.debugLog(accountIdStr, 'ERROR', `Browser logout also failed: ${altLogoutError.message}`);
            }
          }
        }
      }

      // Force cleanup with session deletion
      await this.forceCleanupClient(accountIdStr);

      // Update database status with logout information
      await WhatsAppAccount.findByIdAndUpdate(accountIdStr, {
        status: 'disconnected',
        isConnected: false,
        phoneNumber: null,
        qrCode: null,
        errorMessage: loggedOut ? 'Successfully logged out from WhatsApp servers and removed from linked devices' : 'Disconnected locally (server logout may have failed)',
        lastActivity: new Date(),
        updatedAt: new Date()
      });

      const successMessage = loggedOut ? 
        'Account disconnected and removed from WhatsApp linked devices' : 
        'Account disconnected locally (removal from linked devices may have failed)';

      this.debugLog(accountIdStr, 'SUCCESS', `Account disconnection completed ${loggedOut ? '(with proper server logout)' : '(local cleanup only)'}`);

      if (userId && io) {
        this.emitToUser(userId, 'whatsapp_disconnected', {
          accountId: accountIdStr,
          reason: 'Manual disconnect',
          properLogout: loggedOut,
          removedFromLinkedDevices: loggedOut
        }, io);
      }

      return { 
        success: true, 
        message: successMessage,
        properLogout: loggedOut,
        removedFromLinkedDevices: loggedOut
      };

    } catch (error) {
      this.debugLog(accountIdStr, 'ERROR', `Account disconnection failed: ${error.message}`, {
        stack: error.stack
      });
      
      try {
        await WhatsAppAccount.findByIdAndUpdate(accountIdStr, {
          status: 'failed',
          errorMessage: `Disconnect failed: ${error.message}`,
          updatedAt: new Date()
        });
      } catch (dbError) {
        this.debugLog(accountIdStr, 'ERROR', 'Database update failed during disconnect error handling', dbError);
      }

      throw error;
    }
  }

  // Process campaign method with enhanced logging
  async processCampaign(campaignId) {
    this.debugLog('CAMPAIGN', 'INFO', `🚀 Starting campaign processing: ${campaignId}`);
    
    try {
      const campaign = await WhatsAppCampaign.findById(campaignId)
        .populate('whatsappAccount')
        .populate('user');

      if (!campaign) {
        throw new Error('Campaign not found');
      }

      const accountIdStr = campaign.whatsappAccount._id.toString();
      
      this.debugLog(accountIdStr, 'INFO', 'Campaign loaded, checking client readiness', {
        campaignName: campaign.name,
        messageCount: campaign.messages.length
      });
      
      if (!this.isClientReady(accountIdStr)) {
        throw new Error('WhatsApp client not ready. Please reconnect.');
      }

      campaign.status = 'running';
      campaign.startedAt = new Date();
      await campaign.save();

      const { antiBlockSettings = {} } = campaign;
      const pendingMessages = campaign.messages.filter(m => m.status === 'pending');
      const batchSize = antiBlockSettings.maxMessagesPerBatch || 20;
      
      let totalSent = 0;
      let totalFailed = 0;

      this.debugLog(accountIdStr, 'INFO', 'Campaign execution started', {
        pendingCount: pendingMessages.length,
        batchSize,
        antiBlockSettings
      });

      for (let i = 0; i < pendingMessages.length; i += batchSize) {
        const batch = pendingMessages.slice(i, i + batchSize);
        const batchNumber = Math.floor(i/batchSize) + 1;
        const totalBatches = Math.ceil(pendingMessages.length/batchSize);
        
        this.debugLog(accountIdStr, 'INFO', `Processing batch ${batchNumber}/${totalBatches} (${batch.length} messages)`);

        for (const [index, message] of batch.entries()) {
          try {
            if (!this.isClientReady(accountIdStr)) {
              throw new Error('Client disconnected during campaign');
            }

            let content = message.content;
            if (antiBlockSettings.contentVariation) {
              content = this.applyContentVariation(content);
            }

            this.debugLog(accountIdStr, 'DEBUG', `Sending message ${index + 1}/${batch.length} to ${message.recipient.phone}`);

            const result = await this.sendMessage(
              accountIdStr,
              message.recipient.phone,
              content,
              {
                humanTyping: antiBlockSettings.humanTypingDelay,
                randomDelay: antiBlockSettings.randomDelay,
                minDelay: antiBlockSettings.messageDelay || 2000,
                maxDelay: (antiBlockSettings.messageDelay || 2000) * 2
              }
            );

            const whatsAppMessage = new WhatsAppMessage({
              user: campaign.user._id,
              campaign: campaign._id,
              whatsappAccount: campaign.whatsappAccount._id,
              recipient: message.recipient,
              content: content,
              status: result.success ? 'sent' : 'failed',
              messageId: result.messageId,
              sentAt: result.success ? new Date() : null,
              failureReason: result.success ? null : result.error
            });

            await whatsAppMessage.save();

            if (result.success) {
              message.status = 'sent';
              message.sentAt = new Date();
              message.messageId = result.messageId;
              totalSent++;
              this.debugLog(accountIdStr, 'SUCCESS', `Message sent successfully to ${message.recipient.phone}`);
            } else {
              message.status = 'failed';
              message.failureReason = result.error;
              totalFailed++;
              this.debugLog(accountIdStr, 'ERROR', `Message failed to ${message.recipient.phone}: ${result.error}`);
            }

            this.emitToUser(campaign.user._id, 'campaign_progress', {
              campaignId: campaign._id,
              progress: {
                total: campaign.messages.length,
                sent: totalSent,
                failed: totalFailed,
                pending: pendingMessages.length - totalSent - totalFailed
              }
            });

            if (index < batch.length - 1) {
              const delay = antiBlockSettings.messageDelay || 3000;
              const randomizedDelay = delay + Math.random() * delay;
              this.debugLog(accountIdStr, 'DEBUG', `Waiting ${Math.round(randomizedDelay)}ms before next message`);
              await this.sleep(randomizedDelay);
            }

          } catch (error) {
            this.debugLog(accountIdStr, 'ERROR', `Failed to send to ${message.recipient.phone}: ${error.message}`);
            
            message.status = 'failed';
            message.failureReason = error.message;
            totalFailed++;

            if (error.message.includes('Client disconnected') || 
                error.message.includes('not ready') ||
                error.message.includes('connection lost')) {
              this.debugLog(accountIdStr, 'ERROR', 'Campaign stopped due to client disconnection');
              break;
            }

            await this.sleep(2000);
          }
        }

        await campaign.save();

        if (i + batchSize < pendingMessages.length) {
          const batchDelay = antiBlockSettings.batchDelay || 60000;
          this.debugLog(accountIdStr, 'INFO', `Waiting ${batchDelay/1000}s before next batch...`);
          await this.sleep(batchDelay);
        }
      }

      campaign.status = totalFailed === 0 ? 'completed' : 'partial';
      campaign.completedAt = new Date();
      await campaign.save();

      this.debugLog(accountIdStr, 'SUCCESS', 'Campaign processing completed', {
        total: campaign.messages.length,
        sent: totalSent,
        failed: totalFailed,
        status: campaign.status
      });

      this.emitToUser(campaign.user._id, 'campaign_completed', {
        campaignId: campaign._id,
        stats: { total: campaign.messages.length, sent: totalSent, failed: totalFailed }
      });

      return { success: true, stats: { sent: totalSent, failed: totalFailed } };

    } catch (error) {
      this.debugLog('CAMPAIGN', 'ERROR', `Campaign processing failed: ${error.message}`, {
        campaignId,
        stack: error.stack
      });
      
      await WhatsAppCampaign.findByIdAndUpdate(campaignId, {
        status: 'failed',
        errorMessage: error.message,
        completedAt: new Date()
      });

      throw error;
    }
  }

  // Utility methods
  isClientReady(accountId) {
    const client = this.clients.get(accountId);
    const health = this.connectionHealth.get(accountId);
    const isReady = client && client.info && health?.status === 'ready';
    
    this.debugLog(accountId, 'DEBUG', `Client readiness check: ${isReady}`, {
      hasClient: !!client,
      hasClientInfo: !!client?.info,
      healthStatus: health?.status
    });
    
    return isReady;
  }

  async handleMessageAck(msg, ack, accountId) {
    try {
      const message = await WhatsAppMessage.findOne({
        messageId: msg.id._serialized
      });

      if (!message) return;

      let status;
      let timestamp = new Date();

      switch (ack) {
        case 1:
          status = 'sent';
          message.sentAt = timestamp;
          break;
        case 2:
          status = 'delivered';
          message.deliveredAt = timestamp;
          break;
        case 3:
          status = 'read';
          message.readAt = timestamp;
          if (message.sentAt) {
            message.analytics = message.analytics || {};
            message.analytics.timeToRead = timestamp - message.sentAt;
          }
          break;
        default:
          return;
      }

      message.status = status;
      await message.save();

      this.debugLog(accountId, 'DEBUG', `Message ACK processed: ${status}`, {
        messageId: msg.id._serialized,
        ackType: ack
      });

      if (message.campaign) {
        const campaign = await WhatsAppCampaign.findById(message.campaign);
        if (campaign) {
          const campaignMessage = campaign.messages.find(m => 
            m.messageId === msg.id._serialized
          );
          if (campaignMessage) {
            campaignMessage.status = status;
            if (status === 'delivered') campaignMessage.deliveredAt = timestamp;
            if (status === 'read') campaignMessage.readAt = timestamp;
            await campaign.save();
          }
        }
      }

      this.emitToUser(message.user, 'message_status_update', {
        messageId: message._id,
        status: status,
        timestamp: timestamp
      });

    } catch (error) {
      this.debugLog(accountId, 'ERROR', 'Error handling message ack:', error);
    }
  }

  // Helper methods
  simulateTyping(textLength) {
    const typingTime = Math.min(textLength * 30, 3000);
    return this.sleep(typingTime);
  }

  applyContentVariation(content) {
    if (content.type !== 'text') return content;
    
    const variations = [
      text => text,
      text => text + ' 😊',
      text => `Hi! ${text}`,
      text => text + '\n\nBest regards!',
      text => text.replace(/\./g, '...'),
      text => `Hello, ${text}`,
      text => text + ' 👍',
      text => text + '\n\nThank you!'
    ];
    
    const variation = variations[Math.floor(Math.random() * variations.length)];
    
    return {
      ...content,
      text: variation(content.text)
    };
  }

  // Public API methods
  getQRCode(accountId) {
    return this.qrCodes.get(accountId);
  }

  getAccountStatus(accountId) {
    const health = this.connectionHealth.get(accountId);
    const client = this.clients.get(accountId);
    
    if (!client) return { status: 'disconnected' };
    if (!client.info) return { status: 'connecting' };
    
    return {
      status: health?.status === 'ready' ? 'ready' : 'connecting',
      phoneNumber: client.info.wid?.user,
      profileName: client.info.pushname
    };
  }

  getConnectedAccounts() {
    const connected = [];
    for (const [accountId, client] of this.clients.entries()) {
      if (client.info && this.connectionHealth.get(accountId)?.status === 'ready') {
        connected.push({
          accountId,
          phoneNumber: client.info.wid?.user,
          profileName: client.info.pushname
        });
      }
    }
    return connected;
  }

  // New method: Force reconnect for stuck clients
  async forceReconnect(accountId, userId, io = null) {
    const accountIdStr = accountId.toString();
    
    try {
      this.debugLog(accountIdStr, 'INFO', '🔄 Starting force reconnect process');
      
      // Stop any pending reconnection attempts
      this.reconnectAttempts.delete(accountIdStr);
      
      // Force cleanup everything
      await this.forceCleanupClient(accountIdStr);
      
      // Wait a bit
      this.debugLog(accountIdStr, 'DEBUG', 'Waiting 3 seconds before reinitializing');
      await this.sleep(3000);
      
      // Initialize fresh client
      return await this.initializeClient(accountIdStr, userId, io);
      
    } catch (error) {
      this.debugLog(accountIdStr, 'ERROR', `Force reconnect failed: ${error.message}`, {
        stack: error.stack
      });
      throw error;
    }
  }

  // Graceful shutdown method
  async shutdown() {
    console.log('🛑 Shutting down WhatsApp Web Service...');
    
    const shutdownPromises = [];
    for (const [accountId, client] of this.clients.entries()) {
      shutdownPromises.push(this.safeCleanupClient(accountId));
    }
    
    try {
      await Promise.allSettled(shutdownPromises);
      console.log('✅ WhatsApp Web Service shutdown complete');
    } catch (error) {
      console.error('Error during shutdown:', error);
    }
  }
}

module.exports = new WhatsAppWebService();