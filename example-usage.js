/*
const RavenOracle = require('./ravenOracle');
const config = require('./config'); // You'll need to create this from config.example.js

async function exampleUsage() {
    console.log('Raven Oracle - Example Usage');
    console.log('============================');

    // Initialize oracle
    const { ethers } = require('ethers');
    const provider = new ethers.JsonRpcProvider(config.RPC_URL);

    const oracle = new RavenOracle(
        provider,
        config.RAVEN_ACCESS_ADDRESS
    );

    // Example 1: Check user subscription
    console.log('\n1. Checking user subscription...');
    const userAddress = '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6'; // Example address
    const subscription = await oracle.getUserSubscription(userAddress);
    console.log('Subscription:', subscription);

    // Example 2: Check user eligibility
    console.log('\n2. Checking user eligibility...');
    const eligibility = await oracle.validateUserEligibility(userAddress);
    console.log('Eligibility:', eligibility);

    // Example 3: Get user credits
    console.log('\n3. Getting user credits...');
    const credits = await oracle.getUserCredits(userAddress);
    console.log('Current credits:', credits);

    // Example 4: Calculate credits for different actions
    console.log('\n4. Calculating credits...');
    const aiCredits = oracle.calculateCredits('ai_inference', 30);
    const referralCredits = oracle.calculateCredits('referral', 3);
    const questCredits = oracle.calculateCredits('social_quest', 2);
    
    console.log('30 AI prompts =', aiCredits, 'credits');
    console.log('3 referrals =', referralCredits, 'credits');
    console.log('2 social quests =', questCredits, 'credits');

    // Example 5: Check multiple users eligibility
    console.log('\n5. Checking multiple users eligibility...');
    const testUsers = [userAddress, '0x...', '0x...']; // Add more user addresses
    for (const user of testUsers) {
        const eligibility = await oracle.validateUserEligibility(user);
        console.log(`User ${user}: ${eligibility.eligible ? 'Eligible' : 'Not eligible'} (${eligibility.reason})`);
    }
}

// Example of credit calculation for multiple users
async function calculateCreditsForUsers() {
    console.log('\nCredit Calculation Example');
    console.log('===========================');

    const { ethers } = require('ethers');
    const provider = new ethers.JsonRpcProvider(config.RPC_URL);
    
    const oracle = new RavenOracle(
        provider,
        config.RAVEN_ACCESS_ADDRESS
    );

    // Simulate user actions
    const userActions = [
        { user: '0x...', action: 'ai_inference', parameter: 20 },
        { user: '0x...', action: 'referral', parameter: 2 },
        { user: '0x...', action: 'social_quest', parameter: 3 },
        { user: '0x...', action: 'ai_inference', parameter: 15 },
    ];

    console.log('Calculating credits for user actions:');
    for (const action of userActions) {
        const eligibility = await oracle.validateUserEligibility(action.user);
        const credits = oracle.calculateCredits(action.action, action.parameter);
        
        console.log(`User ${action.user}:`);
        console.log(`  Action: ${action.parameter} ${action.action}`);
        console.log(`  Credits: ${credits}`);
        console.log(`  Eligible: ${eligibility.eligible ? 'Yes' : 'No'} (${eligibility.reason})`);
        console.log('');
    }
}

// Example of monitoring user subscriptions
async function monitorUserSubscriptions() {
    console.log('\nUser Subscription Monitoring');
    console.log('=============================');

    const { ethers } = require('ethers');
    const provider = new ethers.JsonRpcProvider(config.RPC_URL);
    
    const oracle = new RavenOracle(
        provider,
        config.RAVEN_ACCESS_ADDRESS
    );

    const users = [
        '0x742d35Cc6634C0532925a3b8D4C9db96C4b4d8b6',
        '0x...', // Add more user addresses
    ];

    for (const user of users) {
        const subscription = await oracle.getUserSubscription(user);
        const eligibility = await oracle.validateUserEligibility(user);
        const credits = await oracle.getUserCredits(user);

        console.log(`\nUser: ${user}`);
        console.log(`  Plan ID: ${subscription?.planId || 'None'}`);
        console.log(`  Active: ${subscription?.plan.active || false}`);
        console.log(`  Monthly Cap: ${subscription?.plan.monthlyCap || 0}`);
        console.log(`  Used: ${subscription?.usedThisWindow || 0}`);
        console.log(`  Credits: ${credits}`);
        console.log(`  Eligible: ${eligibility.eligible} (${eligibility.reason})`);
    }
}

// Run examples
async function main() {
    try {
        await exampleUsage();
        // await calculateCreditsForUsers();
        // await monitorUserSubscriptions();
    } catch (error) {
        console.error('Error running examples:', error);
    }
}

// Run if called directly
if (require.main === module) {
    main();
}

module.exports = {
    exampleUsage,
    calculateCreditsForUsers,
    monitorUserSubscriptions
};
*/