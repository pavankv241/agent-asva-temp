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
const PROTOCOL_INVITE_SECRET = process.env.PROTOCOL_INVITE_SECRET || null;
// Microsoft Graph / Excel logging config (optional)
const MS_TENANT_ID = process.env.MS_TENANT_ID || null;
const MS_CLIENT_ID = process.env.MS_CLIENT_ID || null;
const MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || null;
const MS_EXCEL_FILE_ID = process.env.MS_EXCEL_FILE_ID || null;
const MS_EXCEL_WORKSHEET_NAME = process.env.MS_EXCEL_WORKSHEET_NAME || 'Invites';
const MS_EXCEL_TABLE_NAME = process.env.MS_EXCEL_TABLE_NAME || 'Table1';

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
let _msGraphToken = null;
let _msGraphTokenExpiresAt = 0;

async function getMsGraphAccessToken() {
  if (_msGraphToken && Date.now() < _msGraphTokenExpiresAt - 60_000) {
    return _msGraphToken;
  }
  if (!MS_TENANT_ID || !MS_CLIENT_ID || !MS_CLIENT_SECRET) {
    console.warn('[excel] Microsoft Graph not configured; invite logging disabled');
    return null;
  }
  try {
    const params = new URLSearchParams();
    params.append('client_id', MS_CLIENT_ID);
    params.append('client_secret', MS_CLIENT_SECRET);
    params.append('scope', 'https://graph.microsoft.com/.default');
    params.append('grant_type', 'client_credentials');

    const resp = await fetch(`https://login.microsoftonline.com/${MS_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    if (!resp.ok) {
      const text = await resp.text();
      console.error('[excel] Failed to get Graph token:', resp.status, text);
      return null;
    }
    const data = await resp.json();
    _msGraphToken = data.access_token;
    const expiresIn = Number(data.expires_in || 3600);
    _msGraphTokenExpiresAt = Date.now() + expiresIn * 1000;
    return _msGraphToken;
  } catch (err) {
    console.error('[excel] Error getting Graph token:', err.message || err);
    return null;
  }
}

async function logInviteToExcel({ referrer, newUser, code, inviteToken }) {
  if (!MS_EXCEL_FILE_ID) return;
  const token = await getMsGraphAccessToken();
  if (!token) return;
  try {
    const timestampIso = new Date().toISOString();
    const url = `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(
      MS_EXCEL_FILE_ID
    )}/workbook/worksheets('${encodeURIComponent(
      MS_EXCEL_WORKSHEET_NAME
    )}')/tables('${encodeURIComponent(MS_EXCEL_TABLE_NAME)}')/rows/add`;

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        values: [[timestampIso, referrer || '', newUser || '', code || '', inviteToken || '']]
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[excel] Failed to append invite row:', resp.status, text);
    }
  } catch (err) {
    console.error('[excel] Error logging invite to Excel:', err.message || err);
  }
}

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

class MemoryCreditUsageStore {
  constructor() {
    this.debits = [];
    this.pendingTotals = new Map();
  }

  async recordDebit(debit) {
    const normalized = normalizeAddress(debit.address);
    const entry = {
      id: debit.id || randomUUID(),
      address: normalized,
      cost: Number(debit.cost) || 0,
      contextHash: debit.contextHash || '',
      reason: debit.reason || '',
      status: 'pending',
      createdAt: Date.now()
    };
    this.debits.push(entry);
    const total = (this.pendingTotals.get(normalized) || 0) + entry.cost;
    this.pendingTotals.set(normalized, total);
    return { id: entry.id, pendingTotal: total };
  }

  async getPendingTotal(address) {
    const normalized = normalizeAddress(address);
    return this.pendingTotals.get(normalized) || 0;
  }

  async fetchPendingDebits() {
    return this.debits
      .filter(d => d.status === 'pending')
      .map(d => ({
        id: d.id,
        address: d.address,
        cost: d.cost,
        reason: d.reason,
        contextHash: d.contextHash
      }));
  }

  async markDebitsSettled(ids, txHash) {
    if (!ids.length) return;
    const idSet = new Set(ids);
    for (const debit of this.debits) {
      if (debit.status === 'pending' && idSet.has(debit.id)) {
        debit.status = 'settled';
        debit.txHash = txHash;
        const current = this.pendingTotals.get(debit.address) || 0;
        const next = Math.max(current - debit.cost, 0);
        if (next === 0) this.pendingTotals.delete(debit.address);
        else this.pendingTotals.set(debit.address, next);
      }
    }
  }
}

class MemorySubscriptionUsageStore {
  constructor() {
    this.usages = [];
  }

  async recordUsage(usage) {
    const normalized = normalizeAddress(usage.address);
    const entry = {
      id: usage.id || randomUUID(),
      address: normalized,
      quantity: Number(usage.quantity) || 0,
      isPriceAccuracyMode: Boolean(usage.isPriceAccuracyMode),
      status: 'pending',
      createdAt: Date.now()
    };
    if (entry.quantity <= 0) {
      return { id: entry.id };
    }
    this.usages.push(entry);
    return { id: entry.id };
  }

  async fetchPendingUsages() {
    return this.usages
      .filter(u => u.status === 'pending' && u.quantity > 0)
      .map(u => ({
        id: u.id,
        address: u.address,
        quantity: u.quantity,
        isPriceAccuracyMode: u.isPriceAccuracyMode
      }));
  }

  async markUsagesSettled(ids, txHash) {
    if (!ids.length) return;
    const idSet = new Set(ids);
    for (const u of this.usages) {
      if (u.status === 'pending' && idSet.has(u.id)) {
        u.status = 'settled';
        u.txHash = txHash;
        u.settledAt = Date.now();
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
      planId: entry.planId ? Number(entry.planId) : null,
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
                 usage.method AS method,
                 usage.planId AS planId
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
        planId: record.get('planId') ? Number(record.get('planId')) : null,
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

class Neo4jCreditUsageStore {
  constructor(driver) {
    this.driver = driver;
  }

  async recordDebit(debit) {
    const session = this.driver.session();
    const id = debit.id || randomUUID();
    try {
      const result = await session.executeWrite(tx =>
        tx.run(
          `
          MERGE (u:User {address: $address})
          CREATE (u)-[:HAS_CREDIT_DEBIT]->(d:CreditDebit {
            id: $id,
            cost: $cost,
            contextHash: $contextHash,
            reason: $reason,
            status: 'pending',
            createdAtMs: timestamp()
          })
          WITH u
          MATCH (u)-[:HAS_CREDIT_DEBIT]->(pending:CreditDebit {status:'pending'})
          RETURN coalesce(sum(pending.cost), 0) AS pendingTotal
          `,
          {
            address: debit.address,
            id,
            cost: Number(debit.cost) || 0,
            contextHash: debit.contextHash || '',
            reason: debit.reason || ''
          }
        )
      );
      const record = result.records?.[0];
      return {
        id,
        pendingTotal: Number(record?.get('pendingTotal') || 0)
      };
    } catch (err) {
      console.error('[Neo4jCreditUsageStore] Error recording debit:', err.message || err);
      throw err;
    } finally {
      await session.close();
    }
  }

  async getPendingTotal(address) {
    const session = this.driver.session();
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          MATCH (u:User {address:$address})-[:HAS_CREDIT_DEBIT]->(d:CreditDebit {status:'pending'})
          RETURN coalesce(sum(d.cost), 0) AS pendingTotal
          `,
          { address }
        )
      );
      const record = result.records?.[0];
      return Number(record?.get('pendingTotal') || 0);
    } catch (err) {
      console.error('[Neo4jCreditUsageStore] Error fetching pending total:', err.message || err);
      throw err;
    } finally {
      await session.close();
    }
  }

  async fetchPendingDebits() {
    const session = this.driver.session();
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          MATCH (u:User)-[:HAS_CREDIT_DEBIT]->(d:CreditDebit {status:'pending'})
          RETURN d.id AS id, u.address AS address, d.cost AS cost, d.reason AS reason, d.contextHash AS contextHash
          `
        )
      );
      return result.records.map(r => ({
        id: r.get('id'),
        address: r.get('address'),
        cost: Number(r.get('cost') || 0),
        reason: r.get('reason') || '',
        contextHash: r.get('contextHash') || ''
      }));
    } catch (err) {
      console.error('[Neo4jCreditUsageStore] Error fetching debits:', err.message || err);
      throw err;
    } finally {
      await session.close();
    }
  }

  async markDebitsSettled(ids, txHash) {
    if (!ids.length) return;
    const session = this.driver.session();
    try {
      await session.executeWrite(tx =>
        tx.run(
          `
          MATCH (:User)-[:HAS_CREDIT_DEBIT]->(d:CreditDebit)
          WHERE d.id IN $ids
          SET d.status = 'settled',
              d.txHash = $txHash,
              d.settledAtMs = timestamp()
          `,
          { ids, txHash }
        )
      );
    } catch (err) {
      console.error('[Neo4jCreditUsageStore] Error marking debits settled:', err.message || err);
      throw err;
    } finally {
      await session.close();
    }
  }
}

class Neo4jSubscriptionUsageStore {
  constructor(driver) {
    this.driver = driver;
  }

  async recordUsage(usage) {
    const session = this.driver.session();
    const id = usage.id || randomUUID();
    try {
      await session.executeWrite(tx =>
        tx.run(
          `
          MERGE (u:User {address:$address})
          CREATE (u)-[:HAS_SUBSCRIPTION_USAGE]->(s:SubscriptionUsage {
            id: $id,
            quantity: $quantity,
            isPriceAccuracyMode: $isPriceAccuracyMode,
            status: 'pending',
            createdAtMs: timestamp()
          })
          `,
          {
            address: usage.address,
            id,
            quantity: Number(usage.quantity) || 0,
            isPriceAccuracyMode: Boolean(usage.isPriceAccuracyMode)
          }
        )
      );
      return { id };
    } catch (err) {
      console.error('[Neo4jSubscriptionUsageStore] Error recording usage:', err.message || err);
      throw err;
    } finally {
      await session.close();
    }
  }

  async fetchPendingUsages() {
    const session = this.driver.session();
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          MATCH (u:User)-[:HAS_SUBSCRIPTION_USAGE]->(s:SubscriptionUsage {status:'pending'})
          RETURN s.id AS id,
                 u.address AS address,
                 s.quantity AS quantity,
                 s.isPriceAccuracyMode AS isPriceAccuracyMode
          `
        )
      );
      return result.records.map(r => ({
        id: r.get('id'),
        address: r.get('address'),
        quantity: Number(r.get('quantity') || 0),
        isPriceAccuracyMode: Boolean(r.get('isPriceAccuracyMode'))
      }));
    } catch (err) {
      console.error('[Neo4jSubscriptionUsageStore] Error fetching usages:', err.message || err);
      throw err;
    } finally {
      await session.close();
    }
  }

  async markUsagesSettled(ids, txHash) {
    if (!ids.length) return;
    const session = this.driver.session();
    try {
      await session.executeWrite(tx =>
        tx.run(
          `
          MATCH (:User)-[:HAS_SUBSCRIPTION_USAGE]->(s:SubscriptionUsage)
          WHERE s.id IN $ids
          SET s.status = 'settled',
              s.txHash = $txHash,
              s.settledAtMs = timestamp()
          `,
          { ids, txHash }
        )
      );
    } catch (err) {
      console.error('[Neo4jSubscriptionUsageStore] Error marking usages settled:', err.message || err);
      throw err;
    } finally {
      await session.close();
    }
  }
}

class Neo4jReferralStore {
  constructor(driver) {
    this.driver = driver;
  }

  async allowReferrals(referrerAddress, allowedAddresses) {
    if (!Array.isArray(allowedAddresses) || !allowedAddresses.length) return { updated: 0 };
    const session = this.driver.session();
    try {
      const lowerRef = referrerAddress.toLowerCase();
      const uniqueAllowed = [...new Set(allowedAddresses.map(a => String(a || '').toLowerCase()).filter(Boolean))];
      if (!uniqueAllowed.length) return { updated: 0 };

      const result = await session.executeWrite(tx =>
        tx.run(
          `
          MERGE (ref:User {address:$referrer})
          WITH ref
          UNWIND $allowed AS addr
          MERGE (u:User {address: addr})
          MERGE (ref)-[:ALLOWS_REFERRAL]->(u)
          RETURN count(u) AS updated
          `,
          { referrer: lowerRef, allowed: uniqueAllowed }
        )
      );
      const updated = Number(result.records?.[0]?.get('updated') || 0);
      return { updated };
    } catch (err) {
      console.error('[Neo4jReferralStore] allowReferrals error:', err.message || err);
      throw err;
    } finally {
      await session.close();
    }
  }

  async isAllowedReferral(referrerAddress, candidateAddress) {
    const session = this.driver.session();
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          MATCH (ref:User {address:$referrer})-[:ALLOWS_REFERRAL]->(u:User {address:$candidate})
          RETURN count(u) AS cnt
          `,
          { referrer: referrerAddress.toLowerCase(), candidate: candidateAddress.toLowerCase() }
        )
      );
      const cnt = Number(result.records?.[0]?.get('cnt') || 0);
      return cnt > 0;
    } catch (err) {
      console.error('[Neo4jReferralStore] isAllowedReferral error:', err.message || err);
      // Fail closed: if check fails, treat as not allowed
      return false;
    } finally {
      await session.close();
    }
  }

  /**
   * Create or refresh an invite token binding a referral code to a specific new user.
   * Only used by the protocol-side /invite endpoint.
   */
  async createInvite(code, newUserAddress, token) {
    const session = this.driver.session();
    try {
      const result = await session.executeWrite(tx =>
        tx.run(
          `
          MATCH (referrer:User)-[:HAS_REFERRAL_CODE]->(c:ReferralCode {code:$code})
          MERGE (newUser:User {address:$newUser})
          MERGE (c)-[:HAS_INVITE]->(invite:ReferralInvite {code:$code, newUser:$newUser})
          ON CREATE SET invite.token = $token,
                        invite.createdAtMs = timestamp(),
                        invite.used = false
          ON MATCH SET invite.token = $token,
                        invite.used = false,
                        invite.updatedAtMs = timestamp()
          RETURN referrer.address AS referrer, invite.token AS token
          `,
          { code, newUser: newUserAddress, token }
        )
      );
      if (!result.records.length) return null;
      const rec = result.records[0];
      return {
        referrer: rec.get('referrer'),
        token: rec.get('token')
      };
    } catch (err) {
      console.error('[Neo4jReferralStore] createInvite error:', err.message || err);
      throw err;
    } finally {
      await session.close();
    }
  }

  async getOrCreateCode(address) {
    const session = this.driver.session();
    try {
      // First, check if code already exists
      const checkResult = await session.executeRead(tx =>
        tx.run(
          `
          MATCH (u:User {address: $address})-[:HAS_REFERRAL_CODE]->(c:ReferralCode)
          RETURN c.code AS code
          `,
          { address }
        )
      );
      
      if (checkResult.records.length > 0) {
        return checkResult.records[0].get('code');
      }
      
      // Code doesn't exist, create a new one
      const createResult = await session.executeWrite(tx =>
        tx.run(
          `
          MERGE (u:User {address: $address})
          WITH u, apoc.text.random(8, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789') AS raw
          WITH u, 'ASV-' + raw AS code
          MERGE (u)-[:HAS_REFERRAL_CODE]->(c:ReferralCode {code: code})
          ON CREATE SET c.createdAtMs = timestamp()
          RETURN c.code AS code
          `,
          { address }
        )
      );
      
      const record = createResult.records?.[0];
      return record?.get('code');
    } catch (err) {
      console.error('[Neo4jReferralStore] getOrCreateCode error:', err.message || err);
      throw err;
    } finally {
      await session.close();
    }
  }

  async redeemCode(code, newUserAddress, inviteToken) {
    const session = this.driver.session();
    try {
      const result = await session.executeWrite(tx =>
        tx.run(
          `
          MATCH (referrer:User)-[:HAS_REFERRAL_CODE]->(c:ReferralCode {code:$code})
          MATCH (c)-[:HAS_INVITE]->(invite:ReferralInvite {code:$code, newUser:$newUser, token:$token, used:false})
          MERGE (newUser:User {address:$newUser})
          WITH referrer, newUser, invite
          OPTIONAL MATCH (:User)-[r:REFERRED]->(newUser)
          WITH referrer, newUser, invite, r
          WHERE r IS NULL AND referrer.address <> newUser.address
          SET invite.used = true,
              invite.usedAtMs = timestamp()
          MERGE (referrer)-[:REFERRED {createdAtMs:timestamp()}]->(newUser)
          RETURN referrer.address AS referrer, newUser.address AS referred
          `,
          { code, newUser: newUserAddress, token: inviteToken }
        )
      );
      if (!result.records.length) return null;
      const rec = result.records[0];
      return {
        referrer: rec.get('referrer'),
        referred: rec.get('referred')
      };
    } catch (err) {
      console.error('[Neo4jReferralStore] redeemCode error:', err.message || err);
      throw err;
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

const creditUsageStore = (() => {
  const driver = getNeo4jDriver();
  if (driver) {
    return new Neo4jCreditUsageStore(driver);
  }
  console.warn('[credit-usage-store] Neo4j not configured, using in-memory store (non-persistent)');
  return new MemoryCreditUsageStore();
})();

const subscriptionUsageStore = (() => {
  const driver = getNeo4jDriver();
  if (driver) {
    return new Neo4jSubscriptionUsageStore(driver);
  }
  console.warn('[subscription-usage-store] Neo4j not configured; subscription usage settlement disabled');
  return null;
})();

const referralStore = (() => {
  const driver = getNeo4jDriver();
  if (driver) {
    return new Neo4jReferralStore(driver);
  }
  console.warn('[referral-store] Neo4j not configured; referral codes will not persist');
  return null;
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
  const [pendingEngagements, pendingCalculations, pendingCreditDebits, pendingSubscriptionUsages] = await Promise.all([
    engagementStore.fetchPendingEngagements(),
    engagementStore.fetchPendingCreditCalculations(),
    creditUsageStore && creditUsageStore.fetchPendingDebits
      ? creditUsageStore.fetchPendingDebits()
      : [],
    subscriptionUsageStore && subscriptionUsageStore.fetchPendingUsages
      ? subscriptionUsageStore.fetchPendingUsages()
      : []
  ]);

  if (!pendingEngagements.length && !pendingCalculations.length && !pendingCreditDebits.length && !pendingSubscriptionUsages.length) {
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

  if (pendingCreditDebits.length) {
    const groupedDebits = new Map();
    for (const debit of pendingCreditDebits) {
      if (!groupedDebits.has(debit.address)) {
        groupedDebits.set(debit.address, { amount: 0, ids: [] });
      }
      const bucket = groupedDebits.get(debit.address);
      bucket.amount += Number(debit.cost) || 0;
      bucket.ids.push(debit.id);
    }

    for (const [address, info] of groupedDebits.entries()) {
      if (info.amount <= 0) continue;
      try {
        const tx = await contract.deductCredits(
          address,
          BigInt(info.amount),
          'inference_cached',
          ''
        );
        const receipt = await tx.wait();
        txResults.push({
          type: 'inference_debit',
          address,
          totalCredits: info.amount,
          txHash: receipt.hash
        });
        if (creditUsageStore && creditUsageStore.markDebitsSettled) {
          await creditUsageStore.markDebitsSettled(info.ids, receipt.hash);
        }
      } catch (err) {
        console.error(`[ClearPendingCredits] failed while settling credit debits for ${address}`, err);
        return { ok: false, trigger, address, message: err.message || 'tx failed' };
      }
    }
  }

  if (pendingSubscriptionUsages.length) {
    const groupedUsage = new Map(); // address -> { quantity, ids }
    for (const u of pendingSubscriptionUsages) {
      if (!groupedUsage.has(u.address)) {
        groupedUsage.set(u.address, { quantity: 0, ids: [] });
      }
      const bucket = groupedUsage.get(u.address);
      bucket.quantity += Number(u.quantity) || 0;
      bucket.ids.push(u.id);
    }

    for (const [address, info] of groupedUsage.entries()) {
      if (info.quantity <= 0) continue;
      try {
        // We now treat monthlyCap as the only cap for all modes, so we set isPriceAccuracyMode = false.
        const tx = await contract.consumeSubscriptionUsage(address, info.quantity, false);
        const receipt = await tx.wait();
        txResults.push({
          type: 'subscription_usage',
          address,
          quantity: info.quantity,
          txHash: receipt.hash
        });
        if (subscriptionUsageStore && subscriptionUsageStore.markUsagesSettled) {
          await subscriptionUsageStore.markUsagesSettled(info.ids, receipt.hash);
        }
      } catch (err) {
        console.error(`[ClearPendingCredits] failed while settling subscription usage for ${address}`, err);
        return { ok: false, trigger, address, message: err.message || 'tx failed' };
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
// body: { mode: string, quantity?: number, reason?: string }
app.post('/inference/estimate', (req, res) => {
  try {
    const { mode, quantity = 1, reason } = req.body || {};
    if (typeof mode !== 'string') return res.status(400).json({ error: 'mode required' });
    const cost = getOracle().getInferenceCost(mode, Number(quantity), reason);
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
    const normalizedMode = String(mode || 'basic').toLowerCase();
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
      const oracle = getOracle();
      const subscription = await oracle.getUserSubscription(user);
      if (!subscription || Number(subscription.planId) === 0) return null;

      const planMonthlyCap = Number(subscription.plan?.monthlyCap ?? 0);
      const planId = Number(subscription.planId);
      const used = Number(subscription.usedThisWindow ?? 0);
      const isPriceAccuracyMode = normalizedMode === 'price_accuracy' || normalizedMode === 'full';
      const effectiveCap = isPriceAccuracyMode ? Number(oracle.GLOBAL_PRICE_ACCURACY_CAP) : planMonthlyCap;

      let remainingValue = remainingOverride;
      if (remainingValue !== undefined && remainingValue !== null) {
        remainingValue = Number(remainingValue);
      }

      if (!Number.isFinite(remainingValue)) {
        remainingValue = Math.max(effectiveCap - used, 0);
      } else {
        remainingValue = Math.max(Math.min(remainingValue, effectiveCap), 0);
      }

      // Final safeguard: Check current stored value and never increase remaining
      // This prevents race conditions and incorrect updates
      if (inferenceStore && inferenceStore.getRemaining) {
        try {
          const currentStored = await inferenceStore.getRemaining(normalizedAddress, normalizedMode);
          if (currentStored && currentStored.remaining !== undefined && currentStored.remaining !== null) {
            const currentRemaining = Number(currentStored.remaining);
            // Never write a value higher than what's currently stored (unless plan changed)
            if (remainingValue > currentRemaining && currentStored.planId === planId) {
              console.warn(`[recordInferenceUsageSnapshot] Prevented remaining increase: current=${currentRemaining}, attempted=${remainingValue} for ${normalizedAddress} mode=${normalizedMode}`);
              // Use current value instead (or current - quantity if this is a usage update)
              // But we don't know quantity here, so just keep current value
              remainingValue = currentRemaining;
            }
          }
        } catch (err) {
          // If check fails, continue with calculated value (fail open)
          console.error('[recordInferenceUsageSnapshot] Error checking current stored value:', err.message || err);
        }
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

async function getPendingCreditUsage(address) {
  if (!creditUsageStore) return 0;
  try {
    const normalized = normalizeAddress(address);
    const total = await creditUsageStore.getPendingTotal(normalized);
    return Number(total) || 0;
  } catch (err) {
    console.error('[credit-usage-store] getPendingCreditUsage error:', err.message || err);
    return 0;
  }
}

async function getPendingEngagementCredits(address) {
  if (!engagementStore || !engagementStore.getPendingForUser) return 0;
  try {
    const normalized = normalizeAddress(address);
    const pending = await engagementStore.getPendingForUser(normalized);
    return Number(pending?.pendingCredits || 0);
  } catch (err) {
    console.error('[engagement-store] getPendingEngagementCredits error:', err.message || err);
    return 0;
  }
}

async function getPendingSubscriptionUsage(address) {
  if (!subscriptionUsageStore || !subscriptionUsageStore.fetchPendingUsages) return 0;
  try {
    const normalized = normalizeAddress(address);
    const allPending = await subscriptionUsageStore.fetchPendingUsages();
    const userPending = allPending
      .filter(u => u.address.toLowerCase() === normalized.toLowerCase())
      .reduce((sum, u) => sum + (Number(u.quantity) || 0), 0);
    return userPending;
  } catch (err) {
    console.error('[subscription-usage-store] getPendingSubscriptionUsage error:', err.message || err);
    return 0;
  }
}

async function cacheCreditAuthorization({ user, cost, contextHash, reason }) {
  if (!creditUsageStore) return;
  const numericCost = Number(cost);
  if (!Number.isFinite(numericCost) || numericCost <= 0) return;
  try {
    const normalized = normalizeAddress(user);
    await creditUsageStore.recordDebit({
      address: normalized,
      cost: numericCost,
      contextHash: contextHash || '',
      reason: reason || 'inference_cached'
    });
  } catch (err) {
    console.error('[cacheCreditAuthorization] error:', err.message || err);
  }
}

async function recordSubscriptionEarnedCredits({ user, credits, planId, reason }) {
  if (!engagementStore) return;
  const amount = Number(credits);
  if (!Number.isFinite(amount) || amount <= 0) return;
  try {
    const normalized = normalizeAddress(user);
    await engagementStore.recordCalculatedCredits(
      normalized,
      reason || 'subscription_usage_reward',
      Number(planId) || 0,
      amount
    );
  } catch (err) {
    console.error('[recordSubscriptionEarnedCredits] error:', err.message || err);
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
    
    // Get current subscription first to check planId
    const subscription = await getOracle().getUserSubscription(user);
    const currentPlanId = subscription ? Number(subscription.planId ?? subscription[0] ?? 0) : 0;
    
    const stored = await getStoredRemainingInference(normalizedAddress, normalizedMode);
    let baseline = null;
    
    // Only use cached value if planId matches current planId
    const cachedPlanId = stored?.planId;
    const planMatches = cachedPlanId !== null && cachedPlanId === currentPlanId;
    const planChanged = cachedPlanId !== null && cachedPlanId !== currentPlanId;
    
    if (stored && stored.remaining !== undefined && stored.remaining !== null && planMatches) {
      // Use cached value only if plan hasn't changed
      // Cache already accounts for all usage (including pending)
      baseline = Number(stored.remaining);
    } else {
      // Plan changed or cache miss: fetch from on-chain first
      const planMonthlyCap = Number(subscription?.plan?.monthlyCap ?? 0);
      
      if (planChanged && planMonthlyCap > 0) {
        // Plan changed: reset to new plan's full cap
        baseline = planMonthlyCap;
      } else {
        // Cache miss: fetch actual on-chain state (includes window reset logic)
        const onchainRemaining = Number(await getOracle().getRemainingInference(user, mode));
        
        // Account for pending usage that hasn't been settled on-chain yet
        const pendingUsage = await getPendingSubscriptionUsage(user);
        baseline = Math.max(0, onchainRemaining - pendingUsage);
        
        // Fallback to planMonthlyCap only if on-chain fetch failed
        if (!Number.isFinite(baseline) || baseline < 0) {
          baseline = planMonthlyCap;
        }
      }
    }
    
    if (!Number.isFinite(baseline)) return;
    const nextRemaining = Math.max(baseline - Number(quantity || 0), 0);

    // Safeguard: Never increase remaining count - it should only decrease
    // If we have a cached value that's lower (more accurate), use that instead
    let finalRemaining = nextRemaining;
    if (stored && stored.remaining !== undefined && stored.remaining !== null && planMatches) {
      const cachedRemaining = Number(stored.remaining);
      // If calculated nextRemaining is higher than cached, something is wrong
      // This means baseline was calculated incorrectly (too high)
      if (nextRemaining > cachedRemaining) {
        // Recalculate from cached value instead
        finalRemaining = Math.max(0, cachedRemaining - Number(quantity || 0));
        console.warn(`[cacheAuthorizationUsage] Prevented remaining increase: cached=${cachedRemaining}, calculated=${nextRemaining}, corrected=${finalRemaining} for ${user}`);
      }
    }

    let earnedCreditsDelta = 0;
    const planMonthlyCap = Number(subscription?.plan?.monthlyCap ?? 0);
    if (planMonthlyCap > 0) {
      // Use the actual baseline that was used (cached if available, otherwise calculated)
      const actualBaseline = (stored && stored.remaining !== undefined && stored.remaining !== null && planMatches) 
        ? Number(stored.remaining) 
        : baseline;
      const totalUsedBefore = planMonthlyCap - actualBaseline;
      const totalUsedAfter = planMonthlyCap - finalRemaining;
      const creditsBefore = Math.floor(totalUsedBefore / 2);
      const creditsAfter = Math.floor(totalUsedAfter / 2);
      earnedCreditsDelta = Math.max(0, creditsAfter - creditsBefore);
    }
    
    // Keep all allowed modes in sync for this plan so remaining is a single shared pool
    const snapshotModes = ['basic', 'tags', 'price_accuracy', 'full', 'general'];
    for (const m of snapshotModes) {
      await recordInferenceUsageSnapshot({
        user,
        mode: m,
        method,
        quantity,
        cost: 0,
        contextHash,
        reason,
        remainingOverride: finalRemaining
      });
    }

    // Record this subscription usage so it can be settled on-chain later via consumeSubscriptionUsage
    if (subscriptionUsageStore && subscriptionUsageStore.recordUsage) {
      await subscriptionUsageStore.recordUsage({
        address: normalizedAddress,
        quantity: Number(quantity) || 0,
        // We no longer treat price_accuracy as having a separate global cap, so always false.
        isPriceAccuracyMode: false
      });
    }

    if (earnedCreditsDelta > 0) {
      await recordSubscriptionEarnedCredits({
        user,
        credits: earnedCreditsDelta,
        planId: currentPlanId
      });
    }
  } catch (err) {
    console.error('[cacheAuthorizationUsage] error:', err.message || err);
  }
}

// Authorization helper (reads on-chain state)
// body: { user: string, mode?: string, quantity?: number, contextHash?: string, reason?: string, tags?: boolean }
app.post('/inference/authorize', async (req, res) => {
  try {
    const { user, mode, quantity = 1, contextHash = '', reason, tags } = req.body || {};
    const checksumUser = normalizeHexAddress(user);
    if (!checksumUser) return res.status(400).json({ error: 'valid user address required' });
    const numericQuantity = Number(quantity);
    if (!Number.isFinite(numericQuantity) || numericQuantity <= 0) {
      return res.status(400).json({ error: 'quantity must be > 0' });
    }
    const contextHashValue = typeof contextHash === 'string' ? contextHash : '';
    const reasonValue = typeof reason === 'string' && reason.length > 0 ? reason : undefined;
    const tagsFlag = Boolean(tags);
    let resolvedMode = (typeof mode === 'string' && mode.length > 0) ? mode : null;
    if (!resolvedMode) {
      resolvedMode = 'basic';
    }

    // Calculate pending usage from Neo4j to prevent exceeding cap before settlement
    // This ensures users can't exceed their monthly cap even if settlement happens hourly
    let pendingUsageFromNeo4j = 0;
    try {
      const subscription = await getOracle().getUserSubscription(checksumUser);
      if (subscription && Number(subscription.planId) > 0 && subscription.plan?.active) {
        const normalizedAddress = normalizeAddress(checksumUser);
        const normalizedMode = resolvedMode.toLowerCase();
        const stored = await getStoredRemainingInference(normalizedAddress, normalizedMode);
        
        // Only use Neo4j pending usage if planId matches (cache is for current plan)
        const currentPlanId = Number(subscription.planId);
        const cachedPlanId = stored?.planId;
        if (stored && stored.remaining !== undefined && stored.remaining !== null &&
            cachedPlanId !== null && cachedPlanId === currentPlanId) {
          const monthlyCap = Number(subscription.plan.monthlyCap);
          const onChainUsed = Number(subscription.usedThisWindow);
          const remainingFromNeo4j = Number(stored.remaining);
          // Calculate pending: total used (from remaining) - on-chain settled usage
          // remaining = monthlyCap - totalUsed, so totalUsed = monthlyCap - remaining
          const totalUsedFromNeo4j = monthlyCap - remainingFromNeo4j;
          pendingUsageFromNeo4j = Math.max(0, totalUsedFromNeo4j - onChainUsed);
        }
      }
    } catch (err) {
      console.error('[authorize] Error calculating pending usage from Neo4j:', err.message || err);
      // Continue with on-chain check only if Neo4j fails
    }

    let pendingCreditsFromNeo4j = 0;
    try {
      pendingCreditsFromNeo4j = await getPendingCreditUsage(checksumUser);
    } catch (err) {
      console.error('[authorize] Error calculating pending credits from Neo4j:', err.message || err);
    }

    let pendingEngagementFromNeo4j = 0;
    try {
      pendingEngagementFromNeo4j = await getPendingEngagementCredits(checksumUser);
    } catch (err) {
      console.error('[authorize] Error calculating pending engagement credits from Neo4j:', err.message || err);
    }

    let pendingCalculatedFromNeo4j = 0;
    try {
      if (engagementStore && engagementStore.getCalculatedCreditsForUser) {
        const normalizedAddress = normalizeAddress(checksumUser);
        const calculated = await engagementStore.getCalculatedCreditsForUser(normalizedAddress);
        pendingCalculatedFromNeo4j = Number(calculated?.totalCalculatedCredits || 0);
      }
    } catch (err) {
      console.error('[authorize] Error calculating pending calculated credits from Neo4j:', err.message || err);
    }

    const result = await getOracle().authorizeInference(
      user,
      resolvedMode,
      numericQuantity,
      pendingUsageFromNeo4j,
      pendingCreditsFromNeo4j,
      pendingCalculatedFromNeo4j,
      pendingEngagementFromNeo4j,
      tagsFlag,
      reasonValue
    );

    if (result?.allowed && result.method === 'subscription') {
      await cacheAuthorizationUsage({
        user: checksumUser,
        mode: resolvedMode,
        quantity: numericQuantity,
        method: result.method,
        contextHash: contextHashValue,
        reason: reasonValue
      });
    } else if (result?.allowed && result.method === 'credits') {
      await cacheCreditAuthorization({
        user: checksumUser,
        cost: result.cost,
        contextHash: contextHashValue,
        reason: reasonValue
      });
    }

    return res.json(serialize({
      ...result,
      mode: resolvedMode,
      contextHash: contextHashValue
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

// Combined summary: subscription, credits, and remaining inference (auto mode)
app.get('/users/:address/summary', async (req, res) => {
  try {
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });

    const [credits, subscription, pendingCalculated, pendingEngagement] = await Promise.all([
      getOracle().getUserCredits(checksumAddr),
      getOracle().getUserSubscription(checksumAddr),
      (async () => {
        if (!engagementStore || !engagementStore.getCalculatedCreditsForUser) return 0;
        try {
          const normalizedAddress = normalizeAddress(checksumAddr);
          const data = await engagementStore.getCalculatedCreditsForUser(normalizedAddress);
          return Number(data?.totalCalculatedCredits || 0);
        } catch (err) {
          console.error('[summary] error fetching pending calculated credits', err.message || err);
          return 0;
        }
      })(),
      getPendingEngagementCredits(checksumAddr)
    ]);

    const planId = subscription ? Number(subscription.planId ?? subscription[0] ?? 0) : 0;
    const hasActiveSub = !!subscription && planId > 0 && subscription.plan?.active;

    // Use 'general' as default mode since all modes share the same subscription pool
    const checkMode = 'general';

    let inference = {
      mode: checkMode,
      remaining: '0',
      source: 'onchain'
    };

    if (!hasActiveSub) {
      inference.reason = 'no_subscription';
    } else {
      const normalizedAddress = normalizeAddress(checksumAddr);
      const normalizedMode = checkMode.toLowerCase();

      // Prefer cached Neo4j remaining (kept in sync by authorizeInference)
      const stored = await getStoredRemainingInference(normalizedAddress, normalizedMode);
      
      // Check if cached planId matches current planId, or if subscription was recently renewed
      const cachedPlanId = stored?.planId;
      const planMatches = cachedPlanId !== null && cachedPlanId === planId;
      const subscriptionRenewedRecently = subscription?.lastRenewedAt 
        ? (Date.now() / 1000 - Number(subscription.lastRenewedAt)) < 300 // Within last 5 minutes
        : false;
      
      const planChanged = cachedPlanId !== null && cachedPlanId !== planId;
      const shouldRefresh = planChanged || subscriptionRenewedRecently;
      
      // Only use cached value if it's valid and we don't need to refresh
      // Cache is the source of truth for remaining count (updated after each authorization)
      if (stored && stored.remaining !== undefined && stored.remaining !== null && 
          Number(stored.remaining) >= 0 && !shouldRefresh && planMatches) {
        // Use cached value if plan hasn't changed and subscription wasn't recently renewed
        // Cache already accounts for pending usage (updated after each authorization)
        inference.remaining = String(stored.remaining);
        inference.source = stored.source || 'neo4j';
        if (stored.updatedAt) {
          inference.updatedAt = stored.updatedAt;
        }
      } else {
        // Plan changed, subscription renewed, or cache miss: fetch from on-chain first
        const planMonthlyCap = Number(subscription?.plan?.monthlyCap ?? 0);
        let remaining = null;
        
        if (planChanged && planMonthlyCap > 0) {
          // Plan changed: reset to new plan's full cap
          remaining = planMonthlyCap;
        } else {
          // Subscription renewed or cache miss: fetch actual on-chain state
          const onChainRemaining = Number(await getOracle().getRemainingInference(checksumAddr, checkMode));
          
          // Account for pending usage that hasn't been settled on-chain yet
          const pendingUsage = await getPendingSubscriptionUsage(checksumAddr);
          remaining = Math.max(0, onChainRemaining - pendingUsage);
        }
        
        // Fallback to planMonthlyCap only if on-chain fetch failed
        if (!Number.isFinite(remaining) || remaining < 0) {
          remaining = planMonthlyCap;
        }
        
        // Safeguard: Never increase remaining count (it should only decrease or stay same)
        // If we have a cached value, only update if new value is lower (more accurate)
        if (stored && stored.remaining !== undefined && stored.remaining !== null) {
          const cachedRemaining = Number(stored.remaining);
          // Only update if new value is lower (more usage) or if plan changed/renewed
          if (remaining > cachedRemaining && !planChanged && !subscriptionRenewedRecently) {
            // Don't overwrite cache with a higher value - use cached value instead
            remaining = cachedRemaining;
            inference.source = stored.source || 'neo4j';
            if (stored.updatedAt) {
              inference.updatedAt = stored.updatedAt;
            }
          }
        }
        
        inference.remaining = String(remaining);
        // Set source if not already set by safeguard logic above
        if (!inference.source) {
          inference.source = planChanged ? 'plan_reset' : 'onchain';
        }
        
        // Update cache with fresh data for all modes (accounting for pending usage)
        // Only update if we're not using cached value (to avoid unnecessary writes)
        if (hasActiveSub && Number.isFinite(remaining) && remaining >= 0 && 
            (!stored || remaining !== Number(stored?.remaining) || planChanged || subscriptionRenewedRecently)) {
          try {
            const snapshotModes = ['basic', 'tags', 'price_accuracy', 'full', 'general'];
            for (const m of snapshotModes) {
            await recordInferenceUsageSnapshot({
              user: checksumAddr,
                mode: m,
              method: 'subscription',
              quantity: 0,
              cost: 0,
              contextHash: '',
              reason: planChanged ? 'plan_changed' : (subscriptionRenewedRecently ? 'subscription_renewed' : 'cache_refresh'),
              remainingOverride: Number(remaining)
            });
            }
          } catch (err) {
            console.error('[summary] failed to refresh cache after plan change/renewal', err);
          }
        }
      }
    }

    const pendingCalculatedCredits = Number(pendingCalculated) || 0;
    let pendingCreditDebits = 0;
    try {
      pendingCreditDebits = await getPendingCreditUsage(checksumAddr);
    } catch (err) {
      console.error('[summary] error fetching pending credit debits', err.message || err);
    }
    const pendingEngagementCredits = Number(pendingEngagement) || 0;
    let effectiveCreditsBig =
      BigInt(credits) +
      BigInt(pendingCalculatedCredits) +
      BigInt(pendingEngagementCredits) -
      BigInt(pendingCreditDebits);
    if (effectiveCreditsBig < 0n) effectiveCreditsBig = 0n;
    const effectiveCredits = effectiveCreditsBig.toString();

    return res.json(serialize({
      address: checksumAddr,
      subscription: subscription || {},
      credits,
      pendingCalculatedCredits: pendingCalculatedCredits.toString(),
      pendingCreditDebits: pendingCreditDebits.toString(),
      pendingEngagementCredits: pendingEngagementCredits.toString(),
      effectiveCredits,
      inference
    }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Generate or fetch referral code for a user
app.post('/referral/code', async (req, res) => {
  try {
    const { address } = req.body || {};
    const checksumAddr = normalizeHexAddress(address);
    if (!checksumAddr) return res.status(400).json({ error: 'valid address required' });
    if (!referralStore) return res.status(500).json({ error: 'referral store not configured' });

    const code = await referralStore.getOrCreateCode(normalizeAddress(checksumAddr));
    if (!code) return res.status(500).json({ error: 'failed to generate referral code' });
    return res.json(serialize({ address: checksumAddr, code }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Protocol-side: create an invite token binding a referral code to a specific new user
// Only callable by backend/protocol using shared secret header: x-protocol-key
// body: { code: string, newUser: string }
app.post('/invite', async (req, res) => {
  try {
    if (!PROTOCOL_INVITE_SECRET) {
      return res.status(500).json({ error: 'invite secret not configured' });
    }

    const authKey = req.headers['x-protocol-key'];
    if (!authKey || authKey !== PROTOCOL_INVITE_SECRET) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const { code, newUser } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'code required' });
    }
    const checksumNewUser = normalizeHexAddress(newUser);
    if (!checksumNewUser) {
      return res.status(400).json({ error: 'valid newUser address required' });
    }
    if (!referralStore) {
      return res.status(500).json({ error: 'referral store not configured' });
    }

    const normalizedNew = normalizeAddress(checksumNewUser);
    const inviteToken = randomUUID().replace(/-/g, '');

    const invite = await referralStore.createInvite(code.trim(), normalizedNew, inviteToken);
    if (!invite) {
      return res.status(400).json({ error: 'invalid_code_or_referrer_not_found' });
    }

    // Log to Microsoft Excel via Graph (best-effort, non-blocking for client)
    logInviteToExcel({
      referrer: invite.referrer,
      newUser: normalizedNew,
      code: code.trim(),
      inviteToken: invite.token
    }).catch(err => {
      console.error('[invite] failed to log to Excel:', err.message || err);
    });

    return res.json(serialize({
      code: code.trim(),
      newUser: normalizedNew,
      referrer: invite.referrer,
      inviteToken: invite.token
    }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Redeem a referral code for a new user, crediting both referrer and referred via engagement pipeline
app.post('/referral/redeem', async (req, res) => {
  try {
    const { code, newUser, inviteToken } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'code required' });
    }
    if (typeof inviteToken !== 'string' || !inviteToken.trim()) {
      return res.status(400).json({ error: 'inviteToken required' });
    }
    const checksumNewUser = normalizeHexAddress(newUser);
    if (!checksumNewUser) return res.status(400).json({ error: 'valid newUser address required' });
    if (!referralStore) return res.status(500).json({ error: 'referral store not configured' });

    const normalizedNew = normalizeAddress(checksumNewUser);
    const mapping = await referralStore.redeemCode(code.trim(), normalizedNew, inviteToken.trim());
    if (!mapping) {
      return res.status(400).json({ error: 'invalid_code_invite_or_already_referred' });
    }
    const referrerAddr = mapping.referrer;
    const referredAddr = mapping.referred;

    if (referrerAddr.toLowerCase() === referredAddr.toLowerCase()) {
      return res.status(400).json({ error: 'self_referral_not_allowed' });
    }

      // Enforce referrer allow-list: referrer must have explicitly allowed this new user
      const isAllowed = await referralStore.isAllowedReferral(referrerAddr, normalizedNew);
      if (!isAllowed) {
        return res.status(400).json({ error: 'referral_not_allowed_by_referrer' });
      }

    const oracle = getOracle();
    const refCredits = oracle.getActionCredit('referral_you_refer') || 0;
    const referredCredits = oracle.getActionCredit('referral_you_are_referred') || 0;

    if (refCredits <= 0 || referredCredits <= 0) {
      return res.status(500).json({ error: 'referral actions not configured' });
    }

    const now = Date.now();

    const refEngagement = {
      id: randomUUID(),
      address: normalizeAddress(referrerAddr),
      action: 'referral_you_refer',
      credits: refCredits,
      xp: refCredits * 2,
      metadata: { referred: referredAddr, code: code.trim() },
      createdAt: now
    };

    const newEngagement = {
      id: randomUUID(),
      address: normalizeAddress(referredAddr),
      action: 'referral_you_are_referred',
      credits: referredCredits,
      xp: referredCredits * 2,
      metadata: { referrer: referrerAddr, code: code.trim() },
      createdAt: now
    };

    const [refResult, newResult] = await Promise.all([
      engagementStore.recordEngagement(refEngagement),
      engagementStore.recordEngagement(newEngagement)
    ]);

    return res.json(serialize({
      referrer: {
        address: refEngagement.address,
        credits: refEngagement.credits,
        xp: refEngagement.xp,
        pendingCredits: refResult.pendingCredits
      },
      referred: {
        address: newEngagement.address,
        credits: newEngagement.credits,
        xp: newEngagement.xp,
        pendingCredits: newResult.pendingCredits
      }
    }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

  // Allow-list specific addresses that a user (referrer) permits as referrals
  // body: { referrer: string, allowed: string[] }
  app.post('/referral/allow', async (req, res) => {
    try {
      const { referrer, allowed } = req.body || {};
      const checksumRef = normalizeHexAddress(referrer);
      if (!checksumRef) return res.status(400).json({ error: 'valid referrer address required' });
      if (!Array.isArray(allowed) || !allowed.length) {
        return res.status(400).json({ error: 'allowed must be non-empty array of addresses' });
      }
      if (!referralStore) return res.status(500).json({ error: 'referral store not configured' });

      const normalizedRef = normalizeAddress(checksumRef);
      const normalizedAllowed = allowed
        .map(a => normalizeHexAddress(a))
        .filter(Boolean)
        .map(a => normalizeAddress(a));
      if (!normalizedAllowed.length) {
        return res.status(400).json({ error: 'no valid addresses in allowed list' });
      }

      const { updated } = await referralStore.allowReferrals(normalizedRef, normalizedAllowed);
      return res.json(serialize({
        referrer: checksumRef,
        updated,
        allowed: normalizedAllowed
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
      console.log(
        `[initial-grant] not eligible for initial grant (hasCredits=${hasCredits}, isSubscribed=${isSubscribed}) for ${checksumUser}`
      );
      return res.json(serialize({
        status: 'ok',
        message: 'not eligible (has credits or active subscription)',
        cached: true
      }));
    }

    // Check if user already received initial grant in Neo4j (pending or settled)
    const normalized = normalizeAddress(checksumUser);
    if (engagementStore && engagementStore.driver) {
      const session = engagementStore.driver.session();
      try {
        const existingGrantResult = await session.executeRead(tx =>
          tx.run(
            `
            MATCH (u:User {address: $address})-[:HAS_CREDIT_CALCULATION]->(c:CreditCalculation)
            WHERE c.reason = 'initial_grant'
            RETURN count(c) AS count
            `,
            { address: normalized }
          )
        );
        const existingCount = existingGrantResult.records[0]?.get('count') || 0;
        if (existingCount > 0) {
          console.log(`[initial-grant] initial grant already received for ${normalized}`);
          return res.json(serialize({ status: 'ok', message: 'initial grant already received', cached: true }));
        }
      } catch (err) {
        console.error('[initial-grant] Error checking existing grant:', err.message || err);
        // Continue to grant if check fails (fail open)
      } finally {
        await session.close();
      }
    }

    await recordSubscriptionEarnedCredits({
      user: normalized,
      credits: 50,
      planId: 0,
      reason: 'initial_grant'
    });
    return res.json(serialize({ status: 'ok', cached: true }));
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
