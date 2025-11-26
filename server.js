require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const { randomUUID } = require('crypto');
const neo4j = require('neo4j-driver');
const RavenOracle = require('./ravenOracle');

const app = express();
app.use(express.json());

// Basic CORS (allow localhost dev and browsers)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function normalizeHexAddress(address) {
  try {
    if (!address || typeof address !== 'string') return null;
    return ethers.getAddress(address.trim());
  } catch (_err) {
    return null;
  }
}

// Env config
const PORT = process.env.PORT || 8080;
const RPC_URL = process.env.RPC_URL || 'https://sepolia.infura.io/v3/YOUR_INFURA_KEY';
const RAVEN_ACCESS_ADDRESS = process.env.RAVEN_ACCESS_ADDRESS || '0x0000000000000000000000000000000000000000';
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY || null;
const BATCH_INTERVAL_MS = Number(process.env.BATCH_INTERVAL_MS || 60 * 60 * 1000);
const NEO4J_URI = process.env.NEO4J_URI || process.env.NEO4J_URL || 'neo4j://localhost:7687';
const NEO4J_USERNAME = process.env.NEO4J_USERNAME || process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || null;

// Helper: JSON-safe serializer for BigInt
function serialize(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v);
    return out;
  }
  return value;
}

// Lazy provider/oracle to avoid crashing when env is missing
let _provider = null;
let _oracle = null;
let _signer = null;
let _treasuryContract = null;
let _neo4jDriver = undefined;

function getProvider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(RPC_URL);
  }
  return _provider;
}

function getOracle() {
  if (_oracle) return _oracle;
  if (!ethers.isAddress(RAVEN_ACCESS_ADDRESS) || RAVEN_ACCESS_ADDRESS === '0x0000000000000000000000000000000000000000') {
    throw new Error('RAVEN_ACCESS_ADDRESS not configured');
  }
  _oracle = new RavenOracle(getProvider(), RAVEN_ACCESS_ADDRESS);
  return _oracle;
}

function getSigner() {
  if (!ORACLE_PRIVATE_KEY) return null;
  if (_signer) return _signer;
  _signer = new ethers.Wallet(ORACLE_PRIVATE_KEY, getProvider());
  return _signer;
}

function getTreasuryContract() {
  if (_treasuryContract) return _treasuryContract;
  const signer = getSigner();
  if (!signer) return null;
  const iface = getOracle().getAccessABI();
  _treasuryContract = new ethers.Contract(RAVEN_ACCESS_ADDRESS, iface, signer);
  return _treasuryContract;
}

function getNeo4jDriver() {
  if (_neo4jDriver !== undefined) return _neo4jDriver;
  if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) {
    _neo4jDriver = null;
    return _neo4jDriver;
  }
  try {
    _neo4jDriver = neo4j.driver(
      NEO4J_URI,
      neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD),
      { 
        disableLosslessIntegers: true,
        maxConnectionLifetime: 3 * 60 * 60 * 1000, // 3 hours
        maxConnectionPoolSize: 50,
        connectionAcquisitionTimeout: 60 * 1000, // 60 seconds
        connectionTimeout: 30 * 1000 // 30 seconds
      }
    );
    // Test connection
    _neo4jDriver.verifyConnectivity().then(() => {
      console.log('[engagement-store] Connected to Neo4j');
    }).catch((err) => {
      console.error('[engagement-store] Neo4j connection verification failed:', err.message);
      // Don't set to null here, let individual queries handle errors
    });
  } catch (err) {
    console.error('[engagement-store] Failed to init Neo4j driver:', err.message);
    _neo4jDriver = null;
  }
  return _neo4jDriver;
}

// ------------------------------
// Pending engagement persistence (Neo4j-backed with in-memory fallback)
// ------------------------------
function normalizeAddress(addr) {
  return ethers.getAddress(addr);
}

class MemoryEngagementStore {
  constructor() {
    this.engagements = [];
    this.pendingTotals = new Map();
    this.calculatedCredits = new Map();
    this.pendingCalculations = [];
  }

  _getTotal(address) {
    return this.pendingTotals.get(address) || 0;
  }

  async recordEngagement(event) {
    const engagement = { ...event, status: 'pending' };
    this.engagements.push(engagement);
    this.pendingTotals.set(engagement.address, this._getTotal(engagement.address) + engagement.credits);
    return {
      engagement,
      pendingCredits: this._getTotal(engagement.address)
    };
  }

  async getPendingForUser(address) {
    const normalized = normalizeAddress(address);
    const events = this.engagements
      .filter(evt => evt.address === normalized && evt.status === 'pending')
      .map(evt => ({
        id: evt.id,
        action: evt.action,
        credits: evt.credits,
        metadata: evt.metadata,
        createdAt: evt.createdAt
      }));
    return {
      address: normalized,
      pendingCredits: this._getTotal(normalized),
      pendingEvents: events
    };
  }

  async getAllPending() {
    const pendingCredits = Array.from(this.pendingTotals.entries()).map(([address, credits]) => ({ address, credits }));
    const pendingEngagements = this.engagements
      .filter(evt => evt.status === 'pending')
      .map(evt => ({
        id: evt.id,
        address: evt.address,
        action: evt.action,
        credits: evt.credits,
        metadata: evt.metadata,
        createdAt: evt.createdAt
      }));
    return { pendingCredits, pendingEngagements };
  }

  async fetchPendingEngagements() {
    return this.engagements
      .filter(evt => evt.status === 'pending')
      .map(evt => ({
        id: evt.id,
        address: evt.address,
        action: evt.action,
        credits: evt.credits
      }));
  }

  async markEngagementsSettled(ids, txHash) {
    if (!ids.length) return;
    const now = Date.now();
    const idSet = new Set(ids);
    for (const evt of this.engagements) {
      if (evt.status === 'pending' && idSet.has(evt.id)) {
        evt.status = 'settled';
        evt.txHash = txHash;
        evt.settledAt = now;
        const newTotal = Math.max(this._getTotal(evt.address) - evt.credits, 0);
        if (newTotal === 0) {
          this.pendingTotals.delete(evt.address);
        } else {
          this.pendingTotals.set(evt.address, newTotal);
        }
      }
    }
  }

  async recordCalculatedCredits(address, reason, parameter, credits) {
    const normalized = normalizeAddress(address);
    const currentTotal = this.calculatedCredits.get(normalized) || 0;
    const newTotal = currentTotal + credits;
    this.calculatedCredits.set(normalized, newTotal);
    // Store pending calculations for settlement
    if (!this.pendingCalculations) {
      this.pendingCalculations = [];
    }
    this.pendingCalculations.push({
      id: randomUUID(),
      address: normalized,
      reason,
      parameter,
      credits,
      status: 'pending'
    });
    return { totalCalculatedCredits: newTotal };
  }

  async getCalculatedCreditsForUser(address) {
    const normalized = normalizeAddress(address);
    const totalCalculatedCredits = this.calculatedCredits.get(normalized) || 0;
    return { address: normalized, totalCalculatedCredits };
  }

  async fetchPendingCreditCalculations() {
    if (!this.pendingCalculations) return [];
    return this.pendingCalculations
      .filter(c => c.status === 'pending')
      .map(c => ({
        id: c.id,
        address: c.address,
        reason: c.reason,
        credits: c.credits
      }));
  }

  async markCreditCalculationsSettled(ids, txHash) {
    if (!ids.length || !this.pendingCalculations) return;
    const idSet = new Set(ids);
    const now = Date.now();
    for (const calc of this.pendingCalculations) {
      if (calc.status === 'pending' && idSet.has(calc.id)) {
        calc.status = 'settled';
        calc.txHash = txHash;
        calc.settledAt = now;
      }
    }
  }
}

class MemoryInferenceUsageStore {
  constructor() {
    this.source = 'memory';
    this.records = new Map();
  }

  _key(address, mode) {
    return `${address.toLowerCase()}::${mode.toLowerCase()}`;
  }

  async recordUsage(snapshot) {
    const key = this._key(snapshot.address, snapshot.mode);
    const entry = {
      ...snapshot,
      updatedAt: snapshot.updatedAt ?? Date.now()
    };
    this.records.set(key, entry);
    return entry;
  }

  async getRemaining(address, mode) {
    const entry = this.records.get(this._key(address, mode));
    if (!entry || entry.remaining === undefined) return null;
    return {
      remaining: entry.remaining,
      updatedAt: entry.updatedAt,
      method: entry.method,
      source: this.source
    };
  }
}

class Neo4jInferenceUsageStore {
  constructor(driver) {
    this.driver = driver;
    this.source = 'neo4j';
  }

  async recordUsage(snapshot) {
    const session = this.driver.session();
    try {
      const payload = {
        address: snapshot.address,
        mode: snapshot.mode,
        remaining: snapshot.remaining ?? '0',
        usedThisWindow: snapshot.usedThisWindow ?? 0,
        planId: snapshot.planId ?? 0,
        planMonthlyCap: snapshot.planMonthlyCap ?? 0,
        method: snapshot.method ?? '',
        quantity: snapshot.quantity ?? 0,
        cost: snapshot.cost ?? '0',
        contextHash: snapshot.contextHash ?? '',
        reason: snapshot.reason ?? '',
        txHash: snapshot.txHash ?? ''
      };
      const result = await session.executeWrite(tx =>
        tx.run(
          `
          MERGE (u:User {address: $address})
          MERGE (u)-[:HAS_INFERENCE_USAGE]->(usage:InferenceUsage {mode: $mode})
          SET usage.remaining = $remaining,
              usage.used = $usedThisWindow,
              usage.planId = $planId,
              usage.planMonthlyCap = $planMonthlyCap,
              usage.method = $method,
              usage.quantity = $quantity,
              usage.cost = $cost,
              usage.contextHash = $contextHash,
              usage.reason = $reason,
              usage.txHash = $txHash,
              usage.updatedAtMs = timestamp()
          RETURN usage.remaining AS remaining,
                 usage.updatedAtMs AS updatedAtMs
          `,
          {
            address: payload.address,
            mode: payload.mode,
            remaining: payload.remaining,
            usedThisWindow: payload.usedThisWindow,
            planId: payload.planId,
            planMonthlyCap: payload.planMonthlyCap,
            method: payload.method,
            quantity: payload.quantity,
            cost: payload.cost,
            contextHash: payload.contextHash,
            reason: payload.reason,
            txHash: payload.txHash
          }
        )
      );
      const record = result.records[0];
      return {
        remaining: record?.get('remaining') ?? snapshot.remaining,
        updatedAt: Number(record?.get('updatedAtMs') || Date.now()),
        source: this.source
      };
    } catch (err) {
      console.error('[Neo4jInferenceUsageStore] Error recording usage:', err.message);
      return null;
    } finally {
      await session.close();
    }
  }

  async getRemaining(address, mode) {
    const session = this.driver.session();
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          MATCH (u:User {address: $address})-[:HAS_INFERENCE_USAGE]->(usage:InferenceUsage {mode: $mode})
          RETURN usage.remaining AS remaining,
                 usage.updatedAtMs AS updatedAtMs,
                 usage.method AS method
          `,
          { address, mode }
        )
      );
      if (!result.records.length) return null;
      const record = result.records[0];
      return {
        remaining: record.get('remaining'),
        updatedAt: Number(record.get('updatedAtMs') || 0),
        method: record.get('method'),
        source: this.source
      };
    } catch (err) {
      console.error('[Neo4jInferenceUsageStore] Error getting remaining:', err.message);
      return null;
    } finally {
      await session.close();
    }
  }
}

class Neo4jEngagementStore {
  constructor(driver) {
    this.driver = driver;
  }

  async recordEngagement(event) {
    const session = this.driver.session();
    const metadataJson = event.metadata && Object.keys(event.metadata).length > 0 ? JSON.stringify(event.metadata) : null;
    try {
      const result = await session.executeWrite(tx =>
        tx.run(
          `
          MERGE (u:User {address: $address})
          ON CREATE SET u.pendingCredits = 0
          CREATE (u)-[:HAS_ENGAGEMENT]->(e:Engagement {
            id: $id,
            action: $action,
            credits: $credits,
            metadataJson: $metadataJson,
            createdAtMs: $createdAt,
            status: 'pending'
          })
          SET u.pendingCredits = coalesce(u.pendingCredits, 0) + $credits
          RETURN u.pendingCredits AS pendingCredits
          `,
          {
            address: event.address,
            id: event.id,
            action: event.action,
            credits: event.credits,
            metadataJson,
            createdAt: event.createdAt
          }
        )
      );
      const pendingCredits = result.records[0]?.get('pendingCredits') ?? event.credits;
      return { pendingCredits: Number(pendingCredits || 0) };
    } catch (err) {
      console.error('[Neo4jEngagementStore] Error recording engagement:', err.message);
      // Return pending credits from event on error
      return { pendingCredits: event.credits };
    } finally {
      await session.close();
    }
  }

  async getPendingForUser(address) {
    const session = this.driver.session();
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          OPTIONAL MATCH (u:User {address: $address})
          WITH u
          OPTIONAL MATCH (u)-[:HAS_ENGAGEMENT]->(e:Engagement {status:'pending'})
          WITH u, collect(e) AS engagements
          RETURN
            CASE WHEN u IS NULL THEN 0 ELSE coalesce(u.pendingCredits, 0) END AS pendingCredits,
            engagements
          `,
          { address }
        )
      );
      const record = result.records[0];
      const pendingCredits = record ? Number(record.get('pendingCredits') || 0) : 0;
      const engagementNodes = record ? record.get('engagements') : [];
      const pendingEvents = (engagementNodes || [])
        .filter(Boolean)
        .map(node => ({
          id: node.properties.id,
          action: node.properties.action,
          credits: Number(node.properties.credits || 0),
          metadata: node.properties.metadataJson ? safeJsonParse(node.properties.metadataJson) : {},
          createdAt: Number(node.properties.createdAtMs || 0)
        }));
      return { address, pendingCredits, pendingEvents };
    } catch (err) {
      console.error('[Neo4jEngagementStore] Error getting pending for user:', err.message);
      // Return empty result on error
      return { address, pendingCredits: 0, pendingEvents: [] };
    } finally {
      await session.close();
    }
  }

  async getAllPending() {
    const session = this.driver.session();
    try {
      const [creditsResult, engagementsResult] = await Promise.all([
        session.executeRead(tx =>
          tx.run(
            `
            MATCH (u:User)
            WHERE coalesce(u.pendingCredits, 0) > 0
            RETURN u.address AS address, u.pendingCredits AS credits
            `
          )
        ),
        session.executeRead(tx =>
          tx.run(
            `
            MATCH (u:User)-[:HAS_ENGAGEMENT]->(e:Engagement {status:'pending'})
            RETURN e.id AS id,
                   u.address AS address,
                   e.action AS action,
                   e.credits AS credits,
                   e.metadataJson AS metadataJson,
                   e.createdAtMs AS createdAt
            `
          )
        )
      ]);

      const pendingCredits = creditsResult.records.map(r => ({
        address: r.get('address'),
        credits: Number(r.get('credits') || 0)
      }));

      const pendingEngagements = engagementsResult.records.map(r => ({
        id: r.get('id'),
        address: r.get('address'),
        action: r.get('action'),
        credits: Number(r.get('credits') || 0),
        metadata: r.get('metadataJson') ? safeJsonParse(r.get('metadataJson')) : {},
        createdAt: Number(r.get('createdAt') || 0)
      }));

      return { pendingCredits, pendingEngagements };
    } catch (err) {
      console.error('[Neo4jEngagementStore] Error getting all pending:', err.message);
      // Return empty result on error
      return { pendingCredits: [], pendingEngagements: [] };
    } finally {
      await session.close();
    }
  }

  async fetchPendingEngagements() {
    const session = this.driver.session();
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          MATCH (u:User)-[:HAS_ENGAGEMENT]->(e:Engagement {status:'pending'})
          RETURN e.id AS id, u.address AS address, e.action AS action, e.credits AS credits
          `
        )
      );
      return result.records.map(r => ({
        id: r.get('id'),
        address: r.get('address'),
        action: r.get('action'),
        credits: Number(r.get('credits') || 0)
      }));
    } finally {
      await session.close();
    }
  }

  async markEngagementsSettled(ids, txHash) {
    if (!ids.length) return;
    const session = this.driver.session();
    try {
      await session.executeWrite(tx =>
        tx.run(
          `
          MATCH (u:User)-[:HAS_ENGAGEMENT]->(e:Engagement)
          WHERE e.id IN $ids
          SET e.status = 'settled',
              e.txHash = $txHash,
              e.settledAtMs = $settledAt
          WITH DISTINCT u
          OPTIONAL MATCH (u)-[:HAS_ENGAGEMENT]->(pending:Engagement {status:'pending'})
          WITH u, coalesce(sum(pending.credits), 0) AS stillPending
          SET u.pendingCredits = stillPending
          `,
          {
            ids,
            txHash,
            settledAt: Date.now()
          }
        )
      );
    } finally {
      await session.close();
    }
  }

  async recordCalculatedCredits(address, reason, parameter, credits) {
    const session = this.driver.session();
    const metadataJson = JSON.stringify({ reason, parameter });
    try {
      const result = await session.executeWrite(tx =>
        tx.run(
          `
          MERGE (u:User {address: $address})
          ON CREATE SET u.calculatedCredits = 0
          CREATE (u)-[:HAS_CREDIT_CALCULATION]->(c:CreditCalculation {
            id: $id,
            reason: $reason,
            parameter: $parameter,
            credits: $credits,
            metadataJson: $metadataJson,
            createdAtMs: $createdAt,
            status: 'pending'
          })
          SET u.calculatedCredits = coalesce(u.calculatedCredits, 0) + $credits
          RETURN u.calculatedCredits AS totalCalculatedCredits
          `,
          {
            address,
            id: randomUUID(),
            reason,
            parameter,
            credits,
            metadataJson,
            createdAt: Date.now()
          }
        )
      );
      const totalCalculatedCredits = result.records[0]?.get('totalCalculatedCredits') ?? credits;
      return { totalCalculatedCredits: Number(totalCalculatedCredits || 0) };
    } catch (err) {
      console.error('[Neo4jEngagementStore] Error recording calculated credits:', err.message);
      // Return credits from parameter on error (at least track it in memory)
      return { totalCalculatedCredits: credits };
    } finally {
      await session.close();
    }
  }

  async getCalculatedCreditsForUser(address) {
    const session = this.driver.session();
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          OPTIONAL MATCH (u:User {address: $address})
          RETURN 
            CASE WHEN u IS NULL THEN 0 ELSE coalesce(u.calculatedCredits, 0) END AS totalCalculatedCredits
          `,
          { address }
        )
      );
      const totalCalculatedCredits = result.records[0] 
        ? Number(result.records[0].get('totalCalculatedCredits') || 0) 
        : 0;
      return { address, totalCalculatedCredits };
    } catch (err) {
      console.error('[Neo4jEngagementStore] Error getting calculated credits:', err.message);
      // Return 0 on error instead of throwing
      return { address, totalCalculatedCredits: 0 };
    } finally {
      await session.close();
    }
  }

  async fetchPendingCreditCalculations() {
    const session = this.driver.session();
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          MATCH (u:User)-[:HAS_CREDIT_CALCULATION]->(c:CreditCalculation {status:'pending'})
          RETURN c.id AS id, u.address AS address, c.reason AS reason, c.credits AS credits
          `
        )
      );
      return result.records.map(r => ({
        id: r.get('id'),
        address: r.get('address'),
        reason: r.get('reason'),
        credits: Number(r.get('credits') || 0)
      }));
    } finally {
      await session.close();
    }
  }

  async markCreditCalculationsSettled(ids, txHash) {
    if (!ids.length) return;
    const session = this.driver.session();
    try {
      await session.executeWrite(tx =>
        tx.run(
          `
          MATCH (u:User)-[:HAS_CREDIT_CALCULATION]->(c:CreditCalculation)
          WHERE c.id IN $ids
          SET c.status = 'settled',
              c.txHash = $txHash,
              c.settledAtMs = $settledAt
          WITH DISTINCT u
          OPTIONAL MATCH (u)-[:HAS_CREDIT_CALCULATION]->(pending:CreditCalculation {status:'pending'})
          WITH u, coalesce(sum(pending.credits), 0) AS stillPending
          SET u.calculatedCredits = stillPending
          `,
          {
            ids,
            txHash,
            settledAt: Date.now()
          }
        )
      );
    } finally {
      await session.close();
    }
  }
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_err) {
    return {};
  }
}

const engagementStore = (() => {
  const driver = getNeo4jDriver();
  if (driver) {
    return new Neo4jEngagementStore(driver);
  }
  console.warn('[engagement-store] Neo4j not configured, using in-memory store (non-persistent)');
  return new MemoryEngagementStore();
})();

const inferenceStore = (() => {
  const driver = getNeo4jDriver();
  if (driver) {
    return new Neo4jInferenceUsageStore(driver);
  }
  console.warn('[inference-store] Neo4j not configured, using in-memory store (non-persistent)');
  return new MemoryInferenceUsageStore();
})();

function isModeAllowedForPlan(planId, mode) {
  const normalizedMode = String(mode || '').toLowerCase();
  switch (Number(planId)) {
    case 1:
      // Plan 1: basic only
      return normalizedMode === 'basic';
    case 2:
      // Plan 2: tags-only
      return normalizedMode === 'tags';
    case 3:
      // Plan 3: price_accuracy + full
      return (
        normalizedMode === 'price_accuracy' ||
        normalizedMode === 'full'
      );
    default:
      return true;
  }
}

async function ClearPendingCredits(trigger = 'timer') {
  const [pendingEngagements, pendingCalculations] = await Promise.all([
    engagementStore.fetchPendingEngagements(),
    engagementStore.fetchPendingCreditCalculations()
  ]);

  if (!pendingEngagements.length && !pendingCalculations.length) {
    return { ok: true, trigger, message: 'no pending credits' };
  }

  const signer = getSigner();
  const contract = getTreasuryContract();
  if (!signer || !contract) {
    console.warn('[ClearPendingCredits] signer not configured; skipping batch');
    return { ok: false, trigger, message: 'signer not configured' };
  }

  const txResults = [];

  // Process engagement credits (like, comment, repost, yap, etc.)
  if (pendingEngagements.length) {
    const grouped = new Map(); // reason -> Map(address -> { amount, ids })
    for (const evt of pendingEngagements) {
      if (!grouped.has(evt.action)) {
        grouped.set(evt.action, new Map());
      }
      const perReason = grouped.get(evt.action);
      if (!perReason.has(evt.address)) {
        perReason.set(evt.address, { amount: 0, ids: [] });
      }
      const bucket = perReason.get(evt.address);
      bucket.amount += evt.credits;
      bucket.ids.push(evt.id);
    }

    for (const [reason, perAddress] of grouped.entries()) {
      const addresses = [];
      const amounts = [];
      const ids = [];

      for (const [address, info] of perAddress.entries()) {
        addresses.push(address);
        amounts.push(info.amount);
        ids.push(...info.ids);
      }

      try {
        const tx = await contract.awardCreditsBatch(addresses, amounts, reason);
        const receipt = await tx.wait();
        txResults.push({
          type: 'engagement',
          reason,
          txHash: receipt.hash,
          addresses: addresses.length,
          totalCredits: amounts.reduce((sum, val) => sum + val, 0)
        });
        await engagementStore.markEngagementsSettled(ids, receipt.hash);
      } catch (err) {
        console.error(`[ClearPendingCredits] failed for engagement reason=${reason}`, err);
        return { ok: false, trigger, reason, message: err.message || 'tx failed' };
      }
    }
  }

  // Process calculated credits (social_quest, prompt_streak, referral, etc.)
  if (pendingCalculations.length) {
    const grouped = new Map(); // reason -> Map(address -> { amount, ids })
    for (const calc of pendingCalculations) {
      if (!grouped.has(calc.reason)) {
        grouped.set(calc.reason, new Map());
      }
      const perReason = grouped.get(calc.reason);
      if (!perReason.has(calc.address)) {
        perReason.set(calc.address, { amount: 0, ids: [] });
      }
      const bucket = perReason.get(calc.address);
      bucket.amount += calc.credits;
      bucket.ids.push(calc.id);
    }

    for (const [reason, perAddress] of grouped.entries()) {
      const addresses = [];
      const amounts = [];
      const ids = [];

      for (const [address, info] of perAddress.entries()) {
        addresses.push(address);
        amounts.push(info.amount);
        ids.push(...info.ids);
      }

      try {
        const tx = await contract.awardCreditsBatch(addresses, amounts, reason);
        const receipt = await tx.wait();
        txResults.push({
          type: 'calculated',
          reason,
          txHash: receipt.hash,
          addresses: addresses.length,
          totalCredits: amounts.reduce((sum, val) => sum + val, 0)
        });
        await engagementStore.markCreditCalculationsSettled(ids, receipt.hash);
      } catch (err) {
        console.error(`[ClearPendingCredits] failed for calculated reason=${reason}`, err);
        return { ok: false, trigger, reason, message: err.message || 'tx failed' };
      }
    }
  }

  return { ok: true, trigger, txResults };
}

// Periodic batch settlement
if (BATCH_INTERVAL_MS > 0) {
  setInterval(() => {
    ClearPendingCredits('interval').catch(err => console.error('batch interval error', err));
  }, BATCH_INTERVAL_MS);
}

// Health
app.get('/health', (_req, res) => {
  res.json(serialize({ status: 'ok' }));
});

// Root
app.get('/', (_req, res) => {
  res.json(serialize({
    status: 'ok',
    service: 'Raven Oracle API',
    hint: 'Use /health or documented endpoints',
    endpoints: [
      'GET /health',
      'POST /inference/estimate',
      'POST /inference/authorize',
      'GET /users/:address/credits',
      'GET /users/:address/xp',
      'GET /users/:address/credits/pending',
      'GET /users/:address/credits/calculated',
      'GET /users/:address/subscription',
      'GET /users/:address/inference/remaining?mode=<mode>',
      'GET /users/:address/has-active-subscription',
      'POST /memory/update',
      'POST /credits/initial-grant',
      'POST /credits/calculate',
      'POST /credits/calculate-and-store',
      'POST /engagement',
      'GET /credits/pending',
      'POST /credits/settle'
    ]
  }));
});

// Estimate credits for arbitrary reason
// body: { reason: string, parameter: number }
app.post('/credits/calculate', (req, res) => {
  try {
    const { reason, parameter } = req.body || {};
    if (typeof reason !== 'string') return res.status(400).json({ error: 'reason required' });
    if (!Number.isFinite(parameter)) return res.status(400).json({ error: 'parameter must be number' });
    const credits = getOracle().calculateCredits(reason, Number(parameter));
    return res.json(serialize({ credits }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Calculate credits and store in Neo4j (accumulating for each user)
// body: { address: string, reason: string, parameter: number }
app.post('/credits/calculate-and-store', async (req, res) => {
  try {
    const { address, reason, parameter } = req.body || {};
    const checksumAddress = normalizeHexAddress(address);
    if (!checksumAddress) return res.status(400).json({ error: 'valid address required' });
    if (typeof reason !== 'string') return res.status(400).json({ error: 'reason required' });
    if (!Number.isFinite(parameter)) return res.status(400).json({ error: 'parameter must be number' });

    const normalizedAddress = normalizeAddress(checksumAddress);
    const credits = getOracle().calculateCredits(reason, Number(parameter));
    
    if (credits <= 0) {
      return res.status(400).json({ error: 'calculated credits must be greater than 0' });
    }

    const { totalCalculatedCredits } = await engagementStore.recordCalculatedCredits(
      normalizedAddress,
      reason,
      Number(parameter),
      credits
    );

    return res.json(serialize({
      address: normalizedAddress,
      reason,
      parameter: Number(parameter),
      credits,
      totalCalculatedCredits
    }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Estimate inference cost
// body: { mode: string, quantity?: number }
app.post('/inference/estimate', (req, res) => {
  try {
    const { mode, quantity = 1 } = req.body || {};
    if (typeof mode !== 'string') return res.status(400).json({ error: 'mode required' });
    const cost = getOracle().getInferenceCost(mode, Number(quantity));
    return res.json(serialize({ cost }));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

async function recordInferenceUsageSnapshot({
  user,
  mode,
  method,
  quantity,
  cost,
  contextHash,
  reason,
  txHash,
  remainingOverride
}) {
  if (!inferenceStore) return null;
  try {
    const normalizedAddress = normalizeAddress(user);
    const normalizedMode = String(mode || '').toLowerCase();
    const payload = {
      address: normalizedAddress,
      mode: normalizedMode,
      method,
      quantity: Number(quantity) || 0,
      cost: cost !== undefined && cost !== null ? String(cost) : '0',
      contextHash: contextHash || '',
      reason: reason || '',
      txHash: txHash || ''
    };

    if (method === 'subscription') {
      let remainingValue = remainingOverride;
      let planMonthlyCap = undefined;
      let planId = undefined;
      let used = undefined;
      if (remainingValue === undefined) {
        const oracle = getOracle();
        const subscription = await oracle.getUserSubscription(user);
        if (!subscription || Number(subscription.planId) === 0) return null;
        planMonthlyCap = Number(subscription.plan?.monthlyCap ?? 0);
        planId = Number(subscription.planId);
        used = Number(subscription.usedThisWindow ?? 0);
        const isPriceAccuracyMode = normalizedMode === 'price_accuracy' || normalizedMode === 'full';
        const effectiveCap = isPriceAccuracyMode ? Number(oracle.GLOBAL_PRICE_ACCURACY_CAP) : planMonthlyCap;
        remainingValue = Math.max(effectiveCap - used, 0);
      }
      payload.planMonthlyCap = planMonthlyCap;
      payload.planId = planId;
      payload.usedThisWindow = used;
      payload.remaining = String(remainingValue ?? 0);
    } else {
      return null;
    }

    return await inferenceStore.recordUsage(payload);
  } catch (err) {
    console.error('[recordInferenceUsageSnapshot] error:', err.message || err);
    return null;
  }
}

async function getStoredRemainingInference(address, mode) {
  if (!inferenceStore) return null;
  try {
    return await inferenceStore.getRemaining(address, mode.toLowerCase());
  } catch (err) {
    console.error('[inference-store] getRemaining error:', err.message || err);
    return null;
  }
}

async function cacheAuthorizationUsage({
  user,
  mode,
  quantity,
  method,
  contextHash,
  reason
}) {
  if (method !== 'subscription') return;
  try {
    const normalizedAddress = normalizeAddress(user);
    const normalizedMode = String(mode || '').toLowerCase();
    const stored = await getStoredRemainingInference(normalizedAddress, normalizedMode);
    let baseline = null;
    if (stored && stored.remaining !== undefined && stored.remaining !== null) {
      baseline = Number(stored.remaining);
    } else {
      const onchainRemaining = await getOracle().getRemainingInference(user, mode);
      baseline = Number(onchainRemaining);
    }
    if (!Number.isFinite(baseline)) return;
    const nextRemaining = Math.max(baseline - Number(quantity || 0), 0);
    // Keep all allowed modes in sync for this plan so remaining is a single shared pool
    const subscription = await getOracle().getUserSubscription(user);
    const planId = subscription ? Number(subscription.planId ?? subscription[0] ?? 0) : 0;
    const candidateModes = ['basic', 'tags', 'price_accuracy', 'full'];
    for (const m of candidateModes) {
      if (!isModeAllowedForPlan(planId, m)) continue;
      await recordInferenceUsageSnapshot({
        user,
        mode: m,
        method,
        quantity,
        cost: 0,
        contextHash,
        reason,
        remainingOverride: nextRemaining
      });
    }
  } catch (err) {
    console.error('[cacheAuthorizationUsage] error:', err.message || err);
  }
}

async function settleInferenceAuthorization({
  user,
  mode,
  quantity,
  method,
  cost,
  contextHash,
  reason
}) {
  const normalizedMode = String(mode || '').toLowerCase();
  const settlement = {
    attempted: true,
    method,
    status: 'skipped'
  };

  const signer = getSigner();
  const contract = getTreasuryContract();
  if (!signer || !contract) {
    return {
      ...settlement,
      status: 'error',
      message: 'oracle signer not configured'
    };
  }

  try {
    let tx = null;
    if (method === 'credits') {
      if (!Number.isFinite(cost) || cost <= 0) {
        return { ...settlement, status: 'error', message: 'invalid cost for credit settlement' };
      }
      tx = await contract.deductCredits(
        user,
        BigInt(cost),
        reason || `inference_${normalizedMode || 'generic'}`,
        contextHash || ''
      );
    } else if (method === 'subscription') {
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return { ...settlement, status: 'error', message: 'invalid quantity for subscription settlement' };
      }
      const isPriceAccuracyMode = normalizedMode === 'price_accuracy' || normalizedMode === 'full';
      tx = await contract.consumeSubscriptionUsage(
        user,
        BigInt(Math.trunc(quantity)),
        isPriceAccuracyMode
      );
    } else {
      return { ...settlement, status: 'skipped', message: `method ${method} does not require settlement` };
    }

    const receipt = await tx.wait();
    await recordInferenceUsageSnapshot({
      user,
      mode,
      method,
      quantity,
      cost,
      contextHash,
      reason,
      txHash: receipt.hash
    });
    return {
      attempted: true,
      method,
      status: 'ok',
      txHash: receipt.hash
    };
  } catch (err) {
    console.error('[settleInferenceAuthorization] failed', err);
    return {
      attempted: true,
      method,
      status: 'error',
      message: err.message || 'settlement tx failed'
    };
  }
}

// Authorization helper (reads on-chain state)
// body: { user: string, mode: string, quantity?: number, settle?: boolean, contextHash?: string, reason?: string }
app.post('/inference/authorize', async (req, res) => {
  try {
    const { user, mode, quantity = 1, settle = false, contextHash = '', reason } = req.body || {};
    const checksumUser = normalizeHexAddress(user);
    if (!checksumUser) return res.status(400).json({ error: 'valid user address required' });
    if (typeof mode !== 'string' || mode.length === 0) return res.status(400).json({ error: 'mode required' });
    const numericQuantity = Number(quantity);
    if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) {
      return res.status(400).json({ error: 'quantity must be > 0' });
    }
    const contextHashValue = typeof contextHash === 'string' ? contextHash : '';
    const reasonValue = typeof reason === 'string' && reason.length > 0 ? reason : undefined;

    const result = await getOracle().authorizeInference(user, mode, numericQuantity);
    let settlement = { attempted: false, status: 'skipped' };

    if (result?.allowed && result.method === 'subscription') {
      await cacheAuthorizationUsage({
        user: checksumUser,
        mode,
        quantity: numericQuantity,
        method: result.method,
        contextHash: contextHashValue,
        reason: reasonValue
      });
    }

    if (
      settle &&
      result?.allowed &&
      (result.method === 'credits' || result.method === 'subscription')
    ) {
      settlement = await settleInferenceAuthorization({
        user: checksumUser,
        mode,
        quantity: numericQuantity,
        method: result.method,
        cost: result.cost,
        contextHash: contextHashValue,
        reason: reasonValue
      });
    }

    return res.json(serialize({
      ...result,
      contextHash: contextHashValue,
      settlement
    }));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// TODO: Add a inference check also offchain.

/*  Front-end example:
import { ethers } from 'ethers';

const resp = await fetch('/memory/update', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user, memoryHash }),
});
const { to, data } = await resp.json();

const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner(); // must be oracle or owner()
const tx = await signer.sendTransaction({ to, data });
await tx.wait();

*/
// Only oracle/owner can update the on-chain user memory pointer.
// This endpoint does NOT sign transactions. It returns calldata so the
// frontend oracle/owner wallet can sign & send directly.
// body: { user: string, memoryHash: string }
app.post('/memory/update', async (req, res) => {
  try {
    const { user, memoryHash } = req.body || {};
    const checksumUser = normalizeHexAddress(user);
    if (!checksumUser) return res.status(400).json({ error: 'valid user address required' });
    if (typeof memoryHash !== 'string' || memoryHash.length === 0) return res.status(400).json({ error: 'memoryHash required' });

    const iface = new ethers.Interface(getOracle().getAccessABI());
    const data = iface.encodeFunctionData('updateUserMemoryPointer', [checksumUser, memoryHash]);
    return res.json(serialize({ to: RAVEN_ACCESS_ADDRESS, data }));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// Record an engagement action (pending credits, stored off-chain)
// body: { address: string, action: string, metadata?: object }
app.post('/engagement', async (req, res) => {
  try {
    const { address, action, metadata = {} } = req.body || {};
    const checksumAddress = normalizeHexAddress(address);
    if (!checksumAddress) return res.status(400).json({ error: 'valid address required' });
    if (typeof action !== 'string' || action.length === 0) return res.status(400).json({ error: 'action required' });

    const credits = getOracle().getActionCredit(action);
    if (credits === null) {
      return res.status(400).json({ error: 'unsupported action' });
    }

    // Calculate XP:XP = Credits * 2 (only for engagement Actions)
    const xp = credits * 2;

    const normalizedAddress = normalizeAddress(checksumAddress);
    const evt = {
      id: randomUUID(),
      address: normalizedAddress,
      action: action.toLowerCase(),
      credits,
      xp,
      metadata,
      createdAt: Date.now()
    };

    const { pendingCredits } = await engagementStore.recordEngagement(evt);

    return res.json(serialize({
      engagementId: evt.id,
      address: normalizedAddress,
      action: evt.action,
      credits,
      xp,
      pendingCredits
    }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Read helpers
app.get('/users/:address/credits', async (req, res) => {
  try {
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });
    const credits = await getOracle().getUserCredits(checksumAddr);
    return res.json(serialize({ address: checksumAddr, credits }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/users/:address/xp', async (req , res) => {
try{
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if(!checksumAddr) return res.status(400).json({error: 'Invalid Address'});
    const oracle = getOracle();
    const contract = new ethers.Contract(RAVEN_ACCESS_ADDRESS , oracle.getAccessABI() , getProvider());
    const xp = await contract.getUserXP(checksumAddr);
    return res.json(serialize({address: checksumAddr , xp: xp.toString()}));
  } catch (e){
    return res.status(500).json({error: e.message});
  }
});

// Pending (off-chain) credits for UI preview
app.get('/users/:address/credits/pending', async (req, res) => {
  try {
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });
    const normalizedAddress = normalizeAddress(checksumAddr);
    const data = await engagementStore.getPendingForUser(normalizedAddress);
    return res.json(serialize(data));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Get calculated credits (accumulated) for a user
app.get('/users/:address/credits/calculated', async (req, res) => {
  try {
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });
    const normalizedAddress = normalizeAddress(checksumAddr);
    const data = await engagementStore.getCalculatedCreditsForUser(normalizedAddress);
    return res.json(serialize(data));
  } catch (e) {
    console.error('[GET /users/:address/credits/calculated] Error:', e.message);
    // Return empty result instead of error to prevent frontend crashes
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if (checksumAddr) {
      return res.json(serialize({ address: normalizeAddress(checksumAddr), totalCalculatedCredits: 0 }));
    }
    return res.status(500).json({ error: e.message });
  }
});

app.get('/users/:address/subscription', async (req, res) => {
  try {
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });
    const sub = await getOracle().getUserSubscription(checksumAddr);
    return res.json(serialize(sub || {}));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Get remaining inference count for a user
// Query param: mode (required) - "basic", "tags", "price_accuracy", or "full"
app.get('/users/:address/inference/remaining', async (req, res) => {
  try {
    const addr = req.params.address;
    let mode = req.query.mode;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });
    const normalizedAddress = normalizeAddress(checksumAddr);
    let normalizedMode = typeof mode === 'string' ? mode.toLowerCase() : '';

    // Fetch subscription to infer default mode when none provided
    const subscription = await getOracle().getUserSubscription(checksumAddr);
    const planId = subscription ? Number(subscription.planId ?? subscription[0] ?? 0) : 0;
    if (!mode || typeof mode !== 'string') {
      // Derive default mode per plan: 1->basic, 2->tags, 3->full
      if (planId === 1) mode = 'basic';
      else if (planId === 2) mode = 'tags';
      else if (planId === 3) mode = 'full';
      else {
        return res.json(serialize({
          address: checksumAddr,
          mode: null,
          remaining: '0',
          source: 'onchain',
          reason: 'no_subscription_or_mode'
        }));
      }
      normalizedMode = mode.toLowerCase();
    }

    // Ensure the user's plan allows this mode before reporting remaining
    if (planId > 0 && subscription?.plan?.active) {
      if (!isModeAllowedForPlan(planId, normalizedMode)) {
        return res.json(serialize({
          address: checksumAddr,
          mode,
          remaining: '0',
          source: 'neo4j',
          reason: 'mode_not_in_plan'
        }));
      }
    } else if (planId === 0) {
      // No subscription: rely on credits (but remaining query is subscription-based)
      // Continue to cached/on-chain path which will likely return 0.
    }

    const stored = await getStoredRemainingInference(normalizedAddress, normalizedMode);
    if (stored && stored.remaining !== undefined && stored.remaining !== null && Number(stored.remaining) > 0) {
      return res.json(serialize({
        address: checksumAddr,
        mode,
        remaining: stored.remaining,
        source: stored.source || 'neo4j',
        updatedAt: stored.updatedAt || Date.now()
      }));
    }

    const remaining = await getOracle().getRemainingInference(checksumAddr, mode);
    // If we have an active subscription and non-zero remaining on-chain after a renewal,
    // refresh the Neo4j cache so future reads pick up the new window.
    if (planId > 0 && subscription?.plan?.active && Number(remaining) > 0) {
      try {
        await recordInferenceUsageSnapshot({
          user: checksumAddr,
          mode,
          method: 'subscription',
          quantity: 0,
          cost: 0,
          contextHash: '',
          reason: 'window_refresh',
          remainingOverride: Number(remaining)
        });
      } catch (err) {
        console.error('[inference/remaining] failed to refresh cache after renewal', err);
      }
    }

    return res.json(serialize({ address: checksumAddr, mode, remaining, source: 'onchain' }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Combined summary: subscription, credits, and remaining inference (auto mode)
app.get('/users/:address/summary', async (req, res) => {
  try {
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });

    const [credits, subscription] = await Promise.all([
      getOracle().getUserCredits(checksumAddr),
      getOracle().getUserSubscription(checksumAddr)
    ]);

    const planId = subscription ? Number(subscription.planId ?? subscription[0] ?? 0) : 0;
    const hasActiveSub = !!subscription && planId > 0 && subscription.plan?.active;

    let inferredMode = null;
    if (hasActiveSub) {
      if (planId === 1) inferredMode = 'basic';
      else if (planId === 2) inferredMode = 'tags';
      else if (planId === 3) inferredMode = 'full';
    }

    let inference = {
      mode: inferredMode,
      remaining: '0',
      source: 'onchain'
    };

    if (!hasActiveSub || !inferredMode) {
      inference.reason = 'no_subscription';
    } else if (!isModeAllowedForPlan(planId, inferredMode)) {
      inference.reason = 'mode_not_in_plan';
    } else {
      // Use the oracle helper for remaining; on-chain is source of truth
      const remaining = await getOracle().getRemainingInference(checksumAddr, inferredMode);
      inference.remaining = String(remaining);
    }

    return res.json(serialize({
      address: checksumAddr,
      subscription: subscription || {},
      credits,
      inference
    }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Check if a user has an active subscription (boolean)
app.get('/users/:address/has-active-subscription', async (req, res) => {
  try {
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });
    const has = await getOracle().hasActiveSubscription(checksumAddr);
    return res.json(serialize({ address: checksumAddr, hasActiveSubscription: !!has }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* Front-end example:
const { to, data } = await (await fetch('/credits/initial-grant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user})})).json();
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner(); // oracle/owner
const tx = await signer.sendTransaction({ to, data });
await tx.wait();
*/
// Prepare calldata for initial 50-credit grant (oracle/owner must sign & send)
// body: { user: string }
app.post('/credits/initial-grant', async (req, res) => {
  try {
    const { user } = req.body || {};
    const checksumUser = normalizeHexAddress(user);
    if (!checksumUser) return res.status(400).json({ error: 'valid user address required' });

    const [creditsStr, subscription] = await Promise.all([
      getOracle().getUserCredits(checksumUser),
      getOracle().getUserSubscription(checksumUser)
    ]);

    const hasCredits = BigInt(creditsStr) > 0n;
    const isSubscribed = !!subscription && Number(subscription.planId) > 0 && subscription.plan.active;
    if (hasCredits || isSubscribed) {
      return res.status(400).json({ error: 'not eligible (has credits or active subscription)' });
    }

    const iface = new ethers.Interface(getOracle().getAccessABI());
    const data = iface.encodeFunctionData('awardCredits', [checksumUser, 50, 'initial_grant']);
    return res.json(serialize({ to: RAVEN_ACCESS_ADDRESS, data }));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// List all pending credits (diagnostic)
app.get('/credits/pending', async (_req, res) => {
  try {
    const snapshot = await engagementStore.getAllPending();
    return res.json(serialize(snapshot));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Force a settlement batch immediately (returns tx summary or reason skipped)
app.post('/credits/settle', async (_req, res) => {
  try {
    const result = await ClearPendingCredits('manual');
    return res.json(serialize(result));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});



// Export app for serverless (Vercel) usage
module.exports = app;

process.on('exit', () => {
  if (_neo4jDriver) {
    _neo4jDriver.close().catch(() => {});
  }
});

// Start local server only when run directly (not in Vercel)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Raven Oracle API listening on :${PORT}`);
  });
}
