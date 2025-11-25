const { ethers } = require('ethers');

class RavenOracle {
    constructor(provider, ravenAccessAddress) {
        this.provider = provider;
        this.ravenAccess = new ethers.Contract(ravenAccessAddress, this.getAccessABI(), provider);

        // Credit calculation constants (matching smart contract)
        this.AI_INFERENCE_PROMPTS_PER_CREDIT = 2; // Prompt streak: every 2 prompts -> +1 credit
        this.REFERRAL_CREDIT_AMOUNT = 6;
        this.SOCIAL_QUEST_CREDIT_AMOUNT = 2;
        this.MAX_SOCIAL_QUESTS_PER_USER = 5;

        // Off-chain engagement actions and fixed credit rewards
        this.ACTION_CREDITS = {
            new_user_bonus: 50,           // 50 credits
            referral_you_refer: 15,       // 15 credits
            referral_you_are_referred: 5, // 5 credits
            like: 2,                      // 2 credits
            comment: 3,                   // 3 credits
            repost: 5,                    // 5 credits
            yap: 6                        // 6 credits
        };

        this.batchInterval = 60 * 60 * 1000; // 1 hour in milliseconds
        this.lastBatchTime = Date.now();

        // Inference mode costs (credits)
        this.COSTS = {
            basic: 1,
            tags: 2,
            price_accuracy: 4,
            full: 6,
            scores: {
                logic: 2,
                sentiment: 2
            }
        };

        // Constraint constants
        this.GLOBAL_PRICE_ACCURACY_CAP = 3000; // across all tiers
        this.RATE_LIMIT_PER_MINUTE = 30; // per user

        // In-memory helpers
        this._rateLimiter = new Map(); // user -> timestamps[] (ms)
        this._grantedInitial = new Set(); // process-local one-time credit grant guard
    }

    // Update user memory pointer on-chain (requires signer)
    async updateUserMemoryPointer(signer, userAddress, memoryHash) {
        if (!signer) throw new Error('Signer is required');
        if (!userAddress) throw new Error('userAddress is required');
        if (!memoryHash) throw new Error('memoryHash is required');

        const contractWithSigner = this.ravenAccess.connect(signer);
        const tx = await contractWithSigner.updateUserMemoryPointer(userAddress, memoryHash);
        const receipt = await tx.wait();
        return receipt;
    }

    // GetActionXP
    getActionXP(action){
        // XP is only for engagement actions, calculated as Credits * 2
        const credits = this.getActionCredit(action);
        return credits !== null ? credits * 2 : null;
    }

    // Note: XP is only for engagements actions , not for calculated credits
    calculateXP(reason, parameter){
        const normalizedReason = String(reason || '').toLowerCase();

        // Check if it's an engagement action (has fixed credits)
        const fixedCredit = this.getActionCredit(normalizedReason);
        if (fixedCredit !== null) {
            // Engagement Action: XP = Credits * 2
            return fixedCredit * 2;
        }

        // For calculated credits (ai_inference, social_quest, etc.), NO XP
        return 0;
    }

    async getUserXP(userAddress){
        try{
            const xp = await this.ravenAccess.getUserXP(userAddress);
            return xp.toString();
        } catch (err){
            console.error('Error Getting User XP', err);
            return '0';
        }
    }



    // Compute credit cost for an inference request
    getInferenceCost(mode, quantity = 1) {
        const path = String(mode).split('.').filter(Boolean);
        if (!path.length) throw new Error('mode required');

        let unit;
        if (path.length === 1) {
            unit = this.COSTS[path[0]];
        } else if (path.length === 2 && path[0] === 'scores') {
            unit = this.COSTS.scores?.[path[1]];
        } else {
            throw new Error(`Unknown mode: ${mode}`);
        }

        if (!Number.isFinite(unit)) throw new Error(`Unknown mode: ${mode}`);
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('quantity must be > 0');
        return unit * quantity;
    }

    // Simple per-process sliding window rate limiter
    isRateLimited(userAddress) {
        const now = Date.now();
        const windowMs = 60 * 1000;
        const arr = this._rateLimiter.get(userAddress) || [];
        const recent = arr.filter(t => now - t <= windowMs);
        const limited = recent.length >= this.RATE_LIMIT_PER_MINUTE;
        // push current attempt
        recent.push(now);
        this._rateLimiter.set(userAddress, recent);
        return limited;
    }

    // Read-only authorization decision based on  priorities
    // Returns: { allowed, method: 'subscription'|'credits'|'deny', reason, cost }
    async authorizeInference(userAddress, mode, quantity = 1) {
        // 1) Rate limit
        if (this.isRateLimited(userAddress)) {
            return { allowed: false, method: 'deny', reason: 'rate_limited', cost: 0 };
        }

        // 2) Fetch on-chain state
        const subscription = await this.getUserSubscription(userAddress);
        const creditsStr = await this.getUserCredits(userAddress);
        const credits = BigInt(creditsStr);

        // 3) Initial one-time 50-credits allowance (process-local guard)
        if (!this._grantedInitial.has(userAddress) && credits === 0n && (!subscription || subscription.planId === 0)) {
            return { allowed: true, method: 'initial_grant', reason: 'initial_50_credits', cost: 0 };
        }

        // 4) Prefer subscription if active
        const isSubscribed = !!subscription && Number(subscription.planId) > 0 && subscription.plan.active;
        const cost = this.getInferenceCost(mode, quantity);
        const isPriceAccuracyMode = mode === 'price_accuracy' || mode === 'full';

        if (isSubscribed) {
            const monthlyCap = Number(subscription.plan.monthlyCap);
            const used = Number(subscription.usedThisWindow);
            const effectiveCap = isPriceAccuracyMode ? this.GLOBAL_PRICE_ACCURACY_CAP : monthlyCap;
            if (used + quantity <= effectiveCap) {
                return { allowed: true, method: 'subscription', reason: 'within_subscription_cap', cost: 0 };
            }
        }

        // 5) Charge credits if available (no subscription / exhausted cap)
        if (credits >= BigInt(cost)) {
            return { allowed: true, method: 'credits', reason: 'sufficient_credits', cost };
        }

        // 6) Fallback: if credits unavailable but subscription still has room (unlikely due to above), allow
        if (isSubscribed) {
            const monthlyCap = Number(subscription.plan.monthlyCap);
            const used = Number(subscription.usedThisWindow);
            const effectiveCap = isPriceAccuracyMode ? this.GLOBAL_PRICE_ACCURACY_CAP : monthlyCap;
            if (used + quantity <= effectiveCap) {
                return { allowed: true, method: 'subscription', reason: 'fallback_subscription', cost: 0 };
            }
        }

        return { allowed: false, method: 'deny', reason: 'insufficient_balance_and_cap', cost };
    }

    // Attempt a one-time initial grant of 50 credits on-chain (requires oracle/owner signer)
    async grantInitialCreditsIfEligible(signer, userAddress) {
        if (!signer) throw new Error('Signer is required');
        if (!userAddress) throw new Error('userAddress is required');
        if (this._grantedInitial.has(userAddress)) return null;

        const creditsStr = await this.getUserCredits(userAddress);
        const subscription = await this.getUserSubscription(userAddress);
        const isSubscribed = !!subscription && Number(subscription.planId) > 0 && subscription.plan.active;
        if (BigInt(creditsStr) > 0n || isSubscribed) return null;

        const contractWithSigner = this.ravenAccess.connect(signer);
        const tx = await contractWithSigner.awardCredits(userAddress, 50, 'initial_grant');
        const receipt = await tx.wait();
        this._grantedInitial.add(userAddress);
        return receipt;
    }

    // Get user subscription info from RavenAccess contract
    async getUserSubscription(userAddress) {
        try {
            // Prefer direct view helper on contract (single call for most fields)
            const res = await this.ravenAccess.getUserSubscription(userAddress);
            // res: (planId, startTs, usedThisWindow, lastRenewedAt, planMonthlyCap, planPriceUnits)
            const planId = res.planId ?? res[0];
            const startTimestamp = res.startTs ?? res[1];
            const usedThisWindow = res.usedThisWindow ?? res[2];
            const lastRenewedAt = res.lastRenewedAt ?? res[3];
            const planMonthlyCap = res.planMonthlyCap ?? res[4];
            const planPriceUnits = res.planPriceUnits ?? res[5];

            // Fetch 'active' flag separately (not included in view helper)
            let active = false;
            if (Number(planId) > 0) {
                const fullPlan = await this.ravenAccess.plans(planId);
                active = Boolean(fullPlan.active);
            }

            return {
                planId,
                startTimestamp,
                usedThisWindow,
                lastRenewedAt,
                plan: {
                    priceUnits: planPriceUnits,
                    monthlyCap: planMonthlyCap,
                    active
                }
            };
        } catch (error) {
            console.error('Error getting user subscription:', error);
            return null;
        }
    }

    // Get user current credits
    async getUserCredits(userAddress) {
        try {
            // Prefer direct view helper for credits
            const credits = await this.ravenAccess.getUserCredits(userAddress);
            return credits.toString();
        } catch (error) {
            console.error('Error getting user credits:', error);
            return '0';
        }
    }

    // Check if user has active subscription
    async hasActiveSubscription(userAddress) {
        const subscription = await this.getUserSubscription(userAddress);
        if (!subscription) return false;

        return subscription.planId > 0 && subscription.plan.active;
    }

    // Check if user has reached monthly cap
    async hasReachedMonthlyCap(userAddress) {
        const subscription = await this.getUserSubscription(userAddress);
        if (!subscription) return true;

        return subscription.usedThisWindow >= subscription.plan.monthlyCap;
    }

    getActionCredit(action) {
        if (!action) return null;
        const key = String(action).toLowerCase();
        const value = this.ACTION_CREDITS[key];
        return typeof value === 'number' ? value : null;
    }

    // Calculate credits based on reason and parameter
    calculateCredits(reason, parameter) {
        const normalizedReason = String(reason || '').toLowerCase();

        // Fixed-credit actions table (from growth/engagement sheet), supports dotted paths
        const fixedCredit = this.getActionCredit(normalizedReason);
        if (fixedCredit !== null) {
            return fixedCredit;
        }

        switch (normalizedReason) {
            case 'ai_inference':
            case 'prompt_streak':
                return Math.floor(parameter / this.AI_INFERENCE_PROMPTS_PER_CREDIT);
            case 'referral':
                return parameter * this.REFERRAL_CREDIT_AMOUNT;
            case 'social_quest': {
                const questCount = Math.min(parameter, this.MAX_SOCIAL_QUESTS_PER_USER);
                return questCount * this.SOCIAL_QUEST_CREDIT_AMOUNT;
            }
            default:
                return parameter; // Custom reasons (fallback)
        }
    }

    // Validate user eligibility for credits
    async validateUserEligibility(userAddress) {
        const hasSubscription = await this.hasActiveSubscription(userAddress);
        const hasReachedCap = await this.hasReachedMonthlyCap(userAddress);

        return {
            eligible: hasSubscription && !hasReachedCap,
            hasSubscription,
            hasReachedCap,
            reason: !hasSubscription ? 'No active subscription' :
                   hasReachedCap ? 'Monthly cap reached' : 'Eligible'
        };
    }



    // Get remaining inference count for a user (calculated off-chain with window reset logic)
    async getRemainingInference(userAddress, mode) {
        try {
            const subscription = await this.getUserSubscription(userAddress);
            
            // No subscription = 0 remaining
            if (!subscription || Number(subscription.planId) === 0) {
                return '0';
            }

            // Apply window reset logic (30-day windows, matching contract logic)
            let usedCount = Number(subscription.usedThisWindow);
            if (subscription.startTimestamp && Number(subscription.startTimestamp) > 0) {
                const DAYS_30_SECONDS = 30 * 24 * 60 * 60; // 2592000 seconds
                const startTimestamp = Number(subscription.startTimestamp);
                // Get current block timestamp (in seconds)
                const currentBlock = await this.provider.getBlock('latest');
                const currentTimestamp = currentBlock ? currentBlock.timestamp : Math.floor(Date.now() / 1000);
                
                // Match contract's _monthWindowStart logic: (timestamp / 30 days) * 30 days
                const lastWindow = Math.floor(startTimestamp / DAYS_30_SECONDS) * DAYS_30_SECONDS;
                const currentWindow = Math.floor(currentTimestamp / DAYS_30_SECONDS) * DAYS_30_SECONDS;
                
                if (currentWindow > lastWindow) {
                    usedCount = 0; // Window reset
                }
            }

            // Determine effective cap based on mode
            const normalizedMode = String(mode || '').toLowerCase();
            const isPriceAccuracyMode = normalizedMode === 'price_accuracy' || normalizedMode === 'full';
            const planCap = Number(subscription.plan.monthlyCap);
            const effectiveCap = isPriceAccuracyMode ? this.GLOBAL_PRICE_ACCURACY_CAP : planCap;

            // Calculate remaining (prevent negative)
            if (usedCount >= effectiveCap) {
                return '0';
            }
            return String(effectiveCap - usedCount);
        } catch (error) {
            console.error('Error getting remaining inference:', error);
            return '0';
        }
    }

    getAccessABI() {
        return [
            "function subscriptions(address user) external view returns (uint8 planId, uint256 startTimestamp, uint256 usedThisWindow, uint256 lastRenewedAt)",
            "function getUserSubscription(address user) external view returns (uint8 planId, uint256 startTs, uint256 usedThisWindow, uint256 lastRenewedAt, uint256 planMonthlyCap, uint256 planPriceUnits)",
            "function plans(uint8 planId) external view returns (uint256 priceUnits, uint256 monthlyCap, bool active)",
            "function credits(address user) external view returns (uint256)",
            "function getUserCredits(address user) external view returns (uint256)",
            "function xp(address user) external view returns (uint256)",
            "function getUserXP(address user) external view returns (uint256)",
            // Writes
            "function updateUserMemoryPointer(address user, string memoryHash) external",
            "function awardCredits(address user, uint256 amount, string reason) external",
            "function awardCreditsBatch(address[] users, uint256[] amounts, string reason) external"
        ];
    }
}

// Example usage
async function main() {
    // Configuration (env overrides recommended for terminal usage)
    const RPC_URL = process.env.RPC_URL || 'https://sepolia.infura.io/v3/YOUR_INFURA_KEY';
    const RAVEN_ACCESS_ADDRESS = process.env.RAVEN_ACCESS_ADDRESS || '0x...';
    //const PRIVATE_KEY = process.env.PRIVATE_KEY || '';

    // Initialize oracle
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const oracle = new RavenOracle(
        provider,
        RAVEN_ACCESS_ADDRESS
    );

    // Signer intentionally not loaded from PRIVATE_KEY in this example.
    let signer = null;

    // Example: Check user subscription
    const userAddress = process.env.USER || '0x...';
    const subscription = await oracle.getUserSubscription(userAddress);
    console.log('User subscription:', subscription);

    // Example: Calculate credits for different actions
    console.log('\nCalculating credits for different actions:');
    const aiCredits = oracle.calculateCredits('ai_inference', 30);
    const referralCredits = oracle.calculateCredits('referral', 5);
    const questCredits = oracle.calculateCredits('social_quest', 3);

    console.log('30 AI prompts =', aiCredits, 'credits');
    console.log('5 referrals =', referralCredits, 'credits');
    console.log('3 social quests =', questCredits, 'credits');
}

// Export for use in other modules
module.exports = RavenOracle;

// Run if called directly
if (require.main === module) {
    main().catch(console.error);
}
