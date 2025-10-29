// Configuration file for Raven Oracle
// Copy this to config.js and fill in your values

module.exports = {
    // Network configuration
    RPC_URL: 'https://sepolia.infura.io/v3/YOUR_INFURA_KEY', // Replace with your RPC URL
    CHAIN_ID: 11155111, // Sepolia testnet
    
    // Contract addresses (update when deployed)
    RAVEN_ACCESS_ADDRESS: '0x0000000000000000000000000000000000000000', // Replace with deployed access address
    
    // Batch configuration
    BATCH_INTERVAL: 60 * 60 * 1000, // 1 hour in milliseconds
    MAX_BATCH_SIZE: 100, // Maximum users per batch
    
    // Credit calculation constants
    CREDIT_CONSTANTS: {
        AI_INFERENCE_PROMPTS_PER_CREDIT: 4,
        REFERRAL_CREDIT_AMOUNT: 6,
        SOCIAL_QUEST_CREDIT_AMOUNT: 2,
        MAX_SOCIAL_QUESTS_PER_USER: 5
    },
    
    // Logging
    LOG_LEVEL: 'info', // debug, info, warn, error
    LOG_TO_FILE: false,
    LOG_FILE_PATH: './oracle.log'
};
