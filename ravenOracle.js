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
            // Base modes
            basic: 1, // general reasoning
            general: 1,
            tags: 1,
            price_accuracy: 4,
            full: 6, // legacy alias, treated as premium reasoning bundle
            scores: {
                logic: 2,
                sentiment: 2
            },
            scores_default: 2,
            // Pricing combinations
            basic_and_tags: 2,
            basic_and_price_accuracy: 4,
            scores_and_basic: 4,
            scores_basic_price_accuracy: 6,
            tags_scores_basic: 3,
            tags_price_accuracy: 4,
            tags_price_accuracy_basic: 5,
            // Tags automatically absorb accuracy/scores surcharges when included
            // Score-specific variants (flat 2 credits regardless of ordering)
            scores_logic: 2,
            scores_sentiment: 2
        };



        this.COST_ALIASES = {
            general_reasoning: 'basic',
            generalreasoning: 'basic',
            gen_reasoning: 'basic',
            reasoning: 'basic',
            general: 'basic',
            tags_general_reasoning: 'basic_and_tags',
            tags_gen_reasoning: 'basic_and_tags',
            tags_reasoning: 'basic_and_tags',
            general_reasoning_accuracy: 'basic_and_price_accuracy',
            gen_reasoning_accuracy: 'basic_and_price_accuracy',
            reasoning_accuracy: 'basic_and_price_accuracy',
            scores_reasoning: 'scores_and_basic',
            scores_general_reasoning: 'scores_and_basic',
            scores_gen_reasoning: 'scores_and_basic',
            scores_reasoning_accuracy: 'scores_basic_price_accuracy',
            scores_general_reasoning_accuracy: 'scores_basic_price_accuracy',
            tags_scores_reasoning: 'tags_scores_basic',
            tags_scores_general_reasoning: 'tags_scores_basic',
            tags_accuracy: 'tags_price_accuracy',
            tags_accuracy_reasoning: 'tags_price_accuracy_basic',
            tags_accuracy_general_reasoning: 'tags_price_accuracy_basic',
            tags_accuracy_gen_reasoning: 'tags_price_accuracy_basic'
        };

        // Constraint constants
        this.GLOBAL_PRICE_ACCURACY_CAP = 3000; // across all tiers
        this.RATE_LIMIT_PER_MINUTE = 30; // per user

        // In-memory helpers
        this._rateLimiter = new Map(); // user -> timestamps[] (ms)
        this._grantedInitial = new Set(); // process-local one-time credit grant guard

        // Small, per-process read cache and in-flight dedupe to shave latency
        this.CACHE_TTL_MS = 5_000;
        this._subscriptionCache = new Map(); // address -> { value, ts }
        this._creditsCache = new Map(); // address -> { value, ts }
        this._inflightSubscription = new Map(); // address -> Promise
        this._inflightCredits = new Map(); // address -> Promise
        this._userStateCache = new Map(); // address -> { subscription, credits, ts }
        this._inflightUserState = new Map(); // address -> Promise

        // Plans now gate only monthly caps; any user may request any supported mode.
    }

    _fromCache(map, key) {
        const entry = map.get(key);
        if (!entry) return null;
        if (Date.now() - entry.ts > this.CACHE_TTL_MS) {
            map.delete(key);
            return null;
        }
        return entry.value;
    }

    _storeCache(map, key, value) {
        map.set(key, { value, ts: Date.now() });
        return value;
    }

    // Invalidate subscription cache for a specific user (useful after purchase/renewal)
    invalidateSubscriptionCache(userAddress) {
        const key = String(userAddress || '').toLowerCase();
        this._subscriptionCache.delete(key);
        this._inflightSubscription.delete(key);
        // Also clear from combined user state cache
        this._userStateCache.delete(key);
        this._inflightUserState.delete(key);
    }

    _fromUserStateCache(key) {
        const entry = this._userStateCache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.ts > this.CACHE_TTL_MS) {
            this._userStateCache.delete(key);
            return null;
        }
        return entry;
    }

    _storeUserStateCache(key, subscription, credits) {
        this._userStateCache.set(key, { subscription, credits, ts: Date.now() });
        return { subscription, credits };
    }

    async getUserState(userAddress) {
        const key = String(userAddress || '').toLowerCase();
        const cached = this._fromUserStateCache(key);
        if (cached) return cached;

        const inflight = this._inflightUserState.get(key);
        if (inflight) return inflight;

        const promise = (async () => {
            try {
                const [subscription, creditsStr] = await Promise.all([
                    this.getUserSubscription(userAddress),
                    this.getUserCredits(userAddress)
                ]);
                return this._storeUserStateCache(key, subscription, creditsStr);
            } finally {
                this._inflightUserState.delete(key);
            }
        })();

        this._inflightUserState.set(key, promise);
        return promise;
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
    getInferenceCost(mode, quantity = 1, reason) {
        if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('quantity must be > 0');

        const normalized = String(mode || 'basic').toLowerCase();
        const path = normalized.split('.').filter(Boolean);
        if (!path.length) throw new Error('mode required');

        let unit;
        if (path.length === 1) {
            unit = this.COSTS[path[0]];
            if (path[0] === 'scores' && !Number.isFinite(unit)) {
                unit = this.COSTS.scores_default;
            }
        } else if (path.length === 2 && path[0] === 'scores') {
            unit = this.COSTS.scores?.[path[1]] ?? this.COSTS[`scores_${path[1]}`];
        } else {
            throw new Error(`Unknown mode: ${mode}`);
        }

        if (!Number.isFinite(unit)) throw new Error(`Unknown mode: ${mode}`);

        const baseUnit = unit;
        const reasonUnit = this._computeReasonCost(reason);

        // If reason-based pricing is available, use it – but never let scores.* modes
        // become cheaper than their base cost (2 credits).
        if (Number.isFinite(reasonUnit)) {
            const isScoresMode = path[0] === 'scores';
            const effectiveUnit = isScoresMode ? Math.max(reasonUnit, baseUnit) : reasonUnit;
            return effectiveUnit * quantity;
        }

        return baseUnit * quantity;
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

    // Read-only authorization decision based on priorities
    // Returns: { allowed, method: 'subscription'|'credits'|'deny', reason, cost }
    // pendingUsageFromNeo4j: optional pending usage count from Neo4j cache (to prevent exceeding cap before settlement)
    // pendingCreditsFromNeo4j: pending credit debits (off-chain)
    // pendingCalculatedFromNeo4j: pending calculated credits (grants) (off-chain)
    // pendingEngagementFromNeo4j: pending engagement credits (likes/referrals/etc.) (off-chain)
    // tagsFlag: when true, we force pricing to include 'tags' even if the reason text doesn't contain it
    async authorizeInference(
        userAddress,
        mode,
        quantity = 1,
        pendingUsageFromNeo4j = 0,
        pendingCreditsFromNeo4j = 0,
        pendingCalculatedFromNeo4j = 0,
        pendingEngagementFromNeo4j = 0,
        tagsFlag = false,
        reason
    ) {
        // 1) Rate limit
        if (this.isRateLimited(userAddress)) {
            return { allowed: false, method: 'deny', reason: 'rate_limited', cost: 0 };
        }

        // 2) Fetch on-chain state (cached/deduped) for subscription + credits
        const { subscription, credits } = await this.getUserState(userAddress);
        const creditsBig = BigInt(credits);
        const pendingCreditDebits = BigInt(pendingCreditsFromNeo4j || 0);
        const pendingCalculated = BigInt(pendingCalculatedFromNeo4j || 0);
        const pendingEngagement = BigInt(pendingEngagementFromNeo4j || 0);
        const grossCredits = creditsBig + pendingCalculated + pendingEngagement;
        const effectiveCredits = grossCredits > pendingCreditDebits ? grossCredits - pendingCreditDebits : 0n;

        // 3) Initial one-time 50-credits allowance (process-local guard)
        if (!this._grantedInitial.has(userAddress) && creditsBig === 0n && (!subscription || subscription.planId === 0)) {
            return { allowed: true, method: 'initial_grant', reason: 'initial_50_credits', cost: 0 };
        }

        // 4) Prefer subscription if active
        const isSubscribed = !!subscription && Number(subscription.planId) > 0 && subscription.plan.active;
        const normalizedMode = String(mode || 'basic').toLowerCase();
        let normalizedReason = typeof reason === 'string' && reason.length > 0 ? reason : undefined;
        if (tagsFlag) {
            const base = normalizedReason || '';
            let augmented = base;

            // Ensure "tags" is present for pricing
            const hasTagsWord = /tag/i.test(augmented);
            if (!hasTagsWord) {
                augmented = augmented ? `${augmented} tags` : 'tags';
            }

            // For basic/empty mode, also imply "general reasoning" so basic+tags => cost 2
            const hasReasonWord = /(\bgeneral\b|\bgen\b|\breasoning\b|\bbasic\b|\breason\b)/i.test(augmented);
            if (!hasReasonWord && (!mode || normalizedMode === 'basic')) {
                augmented = augmented ? `${augmented} general reasoning` : 'general reasoning';
            }

            normalizedReason = augmented;
        }
        const cost = this.getInferenceCost(normalizedMode, quantity, normalizedReason);
        const isPriceAccuracyMode =
            normalizedMode === 'price_accuracy' ||
            normalizedMode === 'full' ||
            normalizedMode.includes('price_accuracy');

        if (isSubscribed) {
            const monthlyCap = Number(subscription.plan.monthlyCap);
            const rollover = Number(subscription.rolloverAllowance ?? 0);
            const effectiveCap = monthlyCap + rollover;
            const used = Number(subscription.usedThisWindow);
            const pendingUsage = Number(pendingUsageFromNeo4j) || 0;
            const totalUsed = used + pendingUsage;
            if (totalUsed + quantity <= effectiveCap) {
                return { allowed: true, method: 'subscription', reason: 'within_subscription_cap', cost: 0 };
            }
        }

        // 5) Charge credits if available (no subscription / exhausted cap)
        if (effectiveCredits >= BigInt(cost)) {
            return {
                allowed: true,
                method: 'credits',
                reason: 'sufficient_credits',
                cost,
                creditsAvailable: effectiveCredits.toString(),
                creditsOnChain: credits.toString(),
                pendingCredits: pendingCreditDebits.toString(),
                pendingCalculatedCredits: pendingCalculated.toString(),
                pendingEngagementCredits: pendingEngagement.toString()
            };
        }

        // 6) Fallback: if credits unavailable but subscription still has room (unlikely due to above), allow
        if (isSubscribed) {
            const monthlyCap = Number(subscription.plan.monthlyCap);
            const rollover = Number(subscription.rolloverAllowance ?? 0);
            const effectiveCapBase = monthlyCap + rollover;
            const used = Number(subscription.usedThisWindow);
            const pendingUsage = Number(pendingUsageFromNeo4j) || 0;
            const effectiveCap = isPriceAccuracyMode
                ? Math.min(effectiveCapBase, this.GLOBAL_PRICE_ACCURACY_CAP)
                : effectiveCapBase;
            const totalUsed = used + pendingUsage;
            if (totalUsed + quantity <= effectiveCap) {
                return { allowed: true, method: 'subscription', reason: 'fallback_subscription', cost: 0 };
            }
        }

        return {
            allowed: false,
            method: 'deny',
            reason: 'insufficient_balance_and_cap',
            cost,
            creditsAvailable: effectiveCredits.toString(),
            creditsOnChain: credits.toString(),
            pendingCredits: pendingCreditDebits.toString(),
            pendingCalculatedCredits: pendingCalculated.toString(),
            pendingEngagementCredits: pendingEngagement.toString()
        };
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
    // Automatically fetches fresh data when subscription is missing to catch recent purchases
    async getUserSubscription(userAddress) {
        const key = String(userAddress || '').toLowerCase();
        
        const cached = this._fromCache(this._subscriptionCache, key);
        // Always fetch fresh data if cached shows no subscription (to catch recent purchases immediately)
        if (cached) {
            const cachedPlanId = cached.planId ?? cached[0] ?? 0;
            // If cached shows no subscription, always bypass cache and fetch fresh from chain
            // This ensures we catch purchases immediately without waiting for cache expiry
            if (Number(cachedPlanId) === 0) {
                // Clear cache to force fresh fetch
                this._subscriptionCache.delete(key);
            } else {
                // Has subscription, use normal cache
                return cached;
            }
        }

        const inflight = this._inflightSubscription.get(key);
        if (inflight) return inflight;

        const promise = (async () => {
        try {
            // Prefer direct view helper on contract (single call for most fields)
            const res = await this.ravenAccess.getUserSubscription(userAddress);
                // res: (planId, startTs, usedThisWindow, lastRenewedAt, planMonthlyCap, planPriceUnits, rolloverAllowance, windowEndsAt)
            const planId = res.planId ?? res[0];
            const startTimestamp = res.startTs ?? res[1];
            const usedThisWindow = res.usedThisWindow ?? res[2];
            const lastRenewedAt = res.lastRenewedAt ?? res[3];
            const planMonthlyCap = res.planMonthlyCap ?? res[4];
            const planPriceUnits = res.planPriceUnits ?? res[5];
                const rolloverAllowance = res.rolloverAllowance ?? res[6];
                const windowEndsAt = res.windowEndsAt ?? res[7];

            // Fetch 'active' flag separately (not included in view helper)
            let active = false;
            if (Number(planId) > 0) {
                const fullPlan = await this.ravenAccess.plans(planId);
                active = Boolean(fullPlan.active);
            }

                const out = {
                planId,
                startTimestamp,
                usedThisWindow,
                lastRenewedAt,
                plan: {
                    priceUnits: planPriceUnits,
                    monthlyCap: planMonthlyCap,
                    active
                    },
                    rolloverAllowance,
                    windowEndsAt
            };
                return this._storeCache(this._subscriptionCache, key, out);
        } catch (error) {
            console.error('Error getting user subscription:', error);
            return null;
            } finally {
                this._inflightSubscription.delete(key);
        }
        })();

        this._inflightSubscription.set(key, promise);
        return promise;
    }

    // Get user current credits
    async getUserCredits(userAddress) {
        const key = String(userAddress || '').toLowerCase();
        const cached = this._fromCache(this._creditsCache, key);
        if (cached) return cached;

        const inflight = this._inflightCredits.get(key);
        if (inflight) return inflight;

        const promise = (async () => {
        try {
            // Prefer direct view helper for credits
            const credits = await this.ravenAccess.getUserCredits(userAddress);
                return this._storeCache(this._creditsCache, key, credits.toString());
        } catch (error) {
            console.error('Error getting user credits:', error);
            return '0';
            } finally {
                this._inflightCredits.delete(key);
        }
        })();

        this._inflightCredits.set(key, promise);
        return promise;
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

    _normalizeCostKey(key) {
        return String(key || '')
            .trim()
            .toLowerCase()
            .replace(/[+\s-]+/g, '_')
            .replace(/[^a-z0-9_.]/g, '');
    }

    _lookupCostByKey(key) {
        if (!key) return undefined;
        const normalized = this._normalizeCostKey(key);
        if (!normalized) return undefined;

        if (Object.prototype.hasOwnProperty.call(this.COSTS, normalized) && Number.isFinite(this.COSTS[normalized])) {
            return this.COSTS[normalized];
        }

        if (normalized.startsWith('scores.') && this.COSTS.scores) {
            const parts = normalized.split('.');
            const value = this.COSTS.scores?.[parts[1]];
            if (Number.isFinite(value)) return value;
        }

        if (normalized.startsWith('scores_') && this.COSTS.scores) {
            const subKey = normalized.replace('scores_', '');
            const value = this.COSTS.scores?.[subKey];
            if (Number.isFinite(value)) return value;
        }

        const aliasTarget = this.COST_ALIASES?.[normalized];
        if (aliasTarget) {
            return this._lookupCostByKey(aliasTarget);
        }

        if (normalized.includes('.')) {
            const fallback = normalized.replace(/\./g, '_');
            if (Number.isFinite(this.COSTS[fallback])) {
                return this.COSTS[fallback];
            }
        }

        return undefined;
    }

    _tokenizeReason(reason) {
        const tokens = new Set();
        const parts = String(reason || '')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);

        for (const part of parts) {
            if (part === 'tag' || part === 'tags') {
                tokens.add('tags');
            } else if (part === 'score' || part === 'scores') {
                tokens.add('scores');
            } else if (part === 'general' || part === 'gen' || part === 'reasoning' || part === 'reason' || part === 'basic') {
                tokens.add('reasoning');
            } else if (
                part === 'accuracy' ||
                part === 'accurate' ||
                part === 'price' ||
                part === 'pricing' ||
                part === 'priceaccuracy' ||
                part === 'price_accuracy' ||
                part === 'timeframe' ||
                part === 'tf'
            ) {
                tokens.add('accuracy');
            }
        }

        return tokens;
    }

    _reasonCostFromTokens(tokens) {
        if (!tokens || tokens.size === 0) return null;

        const hasTags = tokens.has('tags');
        const hasScores = tokens.has('scores');
        const hasReasoning = tokens.has('reasoning');
        const hasAccuracy = tokens.has('accuracy');

        if (!hasTags && !hasScores && !hasReasoning && !hasAccuracy) return null;

        if (!hasTags && !hasScores && !hasAccuracy && hasReasoning) return this.COSTS.basic;

        if (!hasTags && !hasReasoning && !hasAccuracy && hasScores) return this.COSTS.scores_default;

        if (!hasTags && hasScores && hasReasoning && !hasAccuracy) return this.COSTS.scores_and_basic;

        if (!hasTags && hasScores && hasReasoning && hasAccuracy) return this.COSTS.scores_basic_price_accuracy;

        if (!hasTags && !hasScores && hasReasoning && hasAccuracy) return this.COSTS.basic_and_price_accuracy;

        if (!hasTags && !hasScores && !hasReasoning && hasAccuracy) return this.COSTS.price_accuracy;

        if (hasTags) {
            if (hasAccuracy && hasReasoning) return this.COSTS.tags_price_accuracy_basic;
            if (hasAccuracy) return this.COSTS.tags_price_accuracy;
            if (hasScores && hasReasoning) return this.COSTS.tags_scores_basic;
            if (hasReasoning) return this.COSTS.basic_and_tags;
            if (hasScores) return this.COSTS.tags_scores_basic;
            return this.COSTS.tags;
        }

        if (hasReasoning && hasAccuracy) return this.COSTS.basic_and_price_accuracy;

        if (hasScores && hasAccuracy) return this.COSTS.scores_basic_price_accuracy;

        return null;
    }

    _computeReasonCost(reason) {
        if (!reason) return null;
        const direct = this._lookupCostByKey(reason);
        if (Number.isFinite(direct)) return direct;
        const tokens = this._tokenizeReason(reason);
        return this._reasonCostFromTokens(tokens);
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

            // Window reset logic: if window elapsed, remaining is 0 until refreshed on-chain
            let usedCount = Number(subscription.usedThisWindow);
            const windowEndsAt = Number(subscription.windowEndsAt || 0);
            const rolloverAllowance = Number(subscription.rolloverAllowance || 0);

                const currentBlock = await this.provider.getBlock('latest');
                const currentTimestamp = currentBlock ? currentBlock.timestamp : Math.floor(Date.now() / 1000);
                
            if (windowEndsAt > 0 && currentTimestamp > windowEndsAt) {
                return '0';
            }

            const planCap = Number(subscription.plan.monthlyCap);
            const effectiveCap = planCap + rolloverAllowance;

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
            "function getUserSubscription(address user) external view returns (uint8 planId, uint256 startTs, uint256 usedThisWindow, uint256 lastRenewedAt, uint256 planMonthlyCap, uint256 planPriceUnits, uint256 rolloverAllowance, uint256 windowEndsAt)",
            "function plans(uint8 planId) external view returns (uint256 priceUnits, uint256 monthlyCap, bool active)",
            "function credits(address user) external view returns (uint256)",
            "function getUserCredits(address user) external view returns (uint256)",
            "function xp(address user) external view returns (uint256)",
            "function getUserXP(address user) external view returns (uint256)",
            // Writes
            "function updateUserMemoryPointer(address user, string memoryHash) external",
            "function awardCredits(address user, uint256 amount, string reason) external",
            "function awardCreditsBatch(address[] users, uint256[] amounts, string reason) external",
            "function deductCredits(address user, uint256 amount, string reason, string contextHash) external",
            "function consumeSubscriptionUsage(address user, uint256 quantity, bool isPriceAccuracyMode) external"
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
