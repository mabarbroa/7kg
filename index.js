require('dotenv').config();
const { SuiClient, getFullnodeUrl } = require('@mysten/sui.js/client');
const { Ed25519Keypair } = require('@mysten/sui.js/keypairs/ed25519');
const { TransactionBlock } = require('@mysten/sui.js/transactions');
const axios = require('axios');
const winston = require('winston');

// Logger configuration
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'bot.log' }),
        new winston.transports.Console()
    ]
});

class SevenKMomentumBot {
    constructor() {
        // Initialize SUI client
        this.client = new SuiClient({ 
            url: process.env.RPC_URL || getFullnodeUrl('mainnet') 
        });
        
        // Initialize wallet
        this.initializeWallet();
        
        // 7K.ag API configuration
        this.apiBase = 'https://api.7k.ag';
        this.headers = {
            'Content-Type': 'application/json',
            ...(process.env.API_KEY && { 'Authorization': `Bearer ${process.env.API_KEY}` })
        };
        
        // Trading parameters
        this.swapAmount = parseInt(process.env.SWAP_AMOUNT) || 1000000;
        this.minProfitThreshold = parseFloat(process.env.MIN_PROFIT_THRESHOLD) || 0.01;
        this.maxSlippage = parseFloat(process.env.MAX_SLIPPAGE) || 0.005;
        this.tradingInterval = parseInt(process.env.TRADING_INTERVAL) || 30000;
        
        // Momentum parameters
        this.momentumThreshold = parseFloat(process.env.MOMENTUM_THRESHOLD) || 0.02;
        this.priceChangeWindow = parseInt(process.env.PRICE_CHANGE_WINDOW) || 300000;
        
        // Price history for momentum calculation
        this.priceHistory = new Map();
        
        logger.info('7K Momentum Bot initialized successfully');
    }

    initializeWallet() {
        try {
            if (process.env.PRIVATE_KEY) {
                this.keypair = Ed25519Keypair.fromSecretKey(
                    Buffer.from(process.env.PRIVATE_KEY, 'hex')
                );
            } else if (process.env.MNEMONIC) {
                this.keypair = Ed25519Keypair.deriveKeypair(process.env.MNEMONIC);
            } else {
                throw new Error('No private key or mnemonic provided');
            }
            
            this.address = this.keypair.getPublicKey().toSuiAddress();
            logger.info(`Wallet initialized: ${this.address}`);
        } catch (error) {
            logger.error('Failed to initialize wallet:', error);
            process.exit(1);
        }
    }

    async getTokenPrices() {
        try {
            const response = await axios.get(`${this.apiBase}/v1/prices`, {
                headers: this.headers
            });
            return response.data;
        } catch (error) {
            logger.error('Failed to fetch token prices:', error);
            return null;
        }
    }

    async getMomentumRoutes(tokenIn, tokenOut, amount) {
        try {
            const response = await axios.post(`${this.apiBase}/v1/routes/momentum`, {
                tokenIn,
                tokenOut,
                amount,
                slippage: this.maxSlippage,
                enableMomentum: true
            }, {
                headers: this.headers
            });
            
            return response.data;
        } catch (error) {
            logger.error('Failed to get momentum routes:', error);
            return null;
        }
    }

    calculateMomentum(tokenSymbol, currentPrice) {
        const now = Date.now();
        const history = this.priceHistory.get(tokenSymbol) || [];
        
        // Add current price to history
        history.push({ price: currentPrice, timestamp: now });
        
        // Remove old entries outside the window
        const cutoff = now - this.priceChangeWindow;
        const filteredHistory = history.filter(entry => entry.timestamp > cutoff);
        
        this.priceHistory.set(tokenSymbol, filteredHistory);
        
        if (filteredHistory.length < 2) {
            return 0;
        }
        
        // Calculate momentum as price change percentage
        const oldestPrice = filteredHistory[0].price;
        const momentum = (currentPrice - oldestPrice) / oldestPrice;
        
        logger.info(`${tokenSymbol} momentum: ${(momentum * 100).toFixed(2)}%`);
        return momentum;
    }

    async executeSwap(route) {
        try {
            const txb = new TransactionBlock();
            
            // Build transaction using 7K.ag route data
            const swapTx = await this.build7KSwapTransaction(txb, route);
            
            // Sign and execute transaction
            const result = await this.client.signAndExecuteTransactionBlock({
                signer: this.keypair,
                transactionBlock: swapTx,
                options: {
                    showEffects: true,
                    showEvents: true,
                }
            });
            
            logger.info(`Swap executed successfully: ${result.digest}`);
            return result;
        } catch (error) {
            logger.error('Failed to execute swap:', error);
            return null;
        }
    }

    async build7KSwapTransaction(txb, route) {
        // Implementation would depend on 7K.ag's specific transaction format
        // This is a placeholder for the actual 7K.ag SDK integration
        
        // Add swap calls based on route data
        for (const step of route.steps) {
            txb.moveCall({
                target: step.target,
                arguments: step.arguments,
                typeArguments: step.typeArguments
            });
        }
        
        return txb;
    }

    async checkArbitrageOpportunity() {
        try {
            const prices = await this.getTokenPrices();
            if (!prices) return false;
            
            // Define trading pairs for momentum analysis
            const pairs = [
                { tokenIn: 'SUI', tokenOut: 'USDC' },
                { tokenIn: 'USDC', tokenOut: 'SUI' },
                { tokenIn: 'USDT', tokenOut: 'USDC' },
                { tokenIn: 'USDC', tokenOut: 'USDT' }
            ];
            
            for (const pair of pairs) {
                const momentum = this.calculateMomentum(pair.tokenIn, prices[pair.tokenIn]);
                
                // Check if momentum exceeds threshold
                if (Math.abs(momentum) > this.momentumThreshold) {
                    logger.info(`Strong momentum detected for ${pair.tokenIn}: ${(momentum * 100).toFixed(2)}%`);
                    
                    // Get momentum-optimized routes
                    const routes = await this.getMomentumRoutes(
                        pair.tokenIn,
                        pair.tokenOut,
                        this.swapAmount
                    );
                    
                    if (routes && routes.length > 0) {
                        const bestRoute = routes[0];
                        const expectedProfit = this.calculateExpectedProfit(bestRoute);
                        
                        if (expectedProfit > this.minProfitThreshold) {
                            logger.info(`Profitable opportunity found: ${(expectedProfit * 100).toFixed(2)}% profit`);
                            await this.executeSwap(bestRoute);
                            return true;
                        }
                    }
                }
            }
            
            return false;
        } catch (error) {
            logger.error('Error checking arbitrage opportunity:', error);
            return false;
        }
    }

    calculateExpectedProfit(route) {
        // Calculate expected profit based on route data
        const inputAmount = route.inputAmount;
        const outputAmount = route.outputAmount;
        const fees = route.totalFees || 0;
        
        const profit = (outputAmount - inputAmount - fees) / inputAmount;
        return profit;
    }

    async start() {
        logger.info('Starting 7K Momentum Bot...');
        
        // Main trading loop
        const tradingLoop = async () => {
            try {
                await this.checkArbitrageOpportunity();
            } catch (error) {
                logger.error('Error in trading loop:', error);
            }
        };
        
        // Start the trading loop
        setInterval(tradingLoop, this.tradingInterval);
        
        // Initial check
        await tradingLoop();
    }
}

// Start the bot
const bot = new SevenKMomentumBot();
bot.start().catch(error => {
    logger.error('Failed to start bot:', error);
    process.exit(1);
});
