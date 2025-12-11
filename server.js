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

function subscriptionEffectiveCap(subscription) {
  if (!subscription) return 0;
  const base = Number(subscription.plan?.monthlyCap ?? 0);
  const rollover = Number(subscription.rolloverAllowance ?? 0);
  return base + rollover;
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
const MS_USER_ID = process.env.MS_USER_ID || null; // User ID or UPN for app-only auth (e.g., pavan.kumar@asvalabs.com)

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

// Get Excel API base URL (supports app-only auth)
function getExcelApiBase() {
  if (!MS_EXCEL_FILE_ID) return null;
  // For app-only auth, use /users/{userId}/drive instead of /me/drive
  if (MS_USER_ID) {
    return `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(MS_USER_ID)}/drive/items/${encodeURIComponent(MS_EXCEL_FILE_ID)}`;
  }
  // Fallback to /me for delegated auth
  return `https://graph.microsoft.com/v1.0/me/drive/items/${encodeURIComponent(MS_EXCEL_FILE_ID)}`;
}

// Read all rows from Excel table
async function getExcelTableRows() {
  if (!MS_EXCEL_FILE_ID) return null;
  const token = await getMsGraphAccessToken();
  if (!token) return null;
  try {
    const base = getExcelApiBase();
    if (!base) return null;
    const url = `${base}/workbook/worksheets('${encodeURIComponent(
      MS_EXCEL_WORKSHEET_NAME
    )}')/tables('${encodeURIComponent(MS_EXCEL_TABLE_NAME)}')/rows`;
    
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[excel] Failed to read table rows:', resp.status, text);
      return null;
    }
    const data = await resp.json();
    return data.value || [];
  } catch (err) {
    console.error('[excel] Error reading table rows:', err.message || err);
    return null;
  }
}

// Helper to extract code from Excel cell (handles CSV format where entire row might be in first cell)
function extractCodeFromCell(cellValue) {
  if (!cellValue) return '';
  const str = cellValue.toString().trim();
  // If cell contains commas, it's likely CSV format - extract first part before comma
  if (str.includes(',')) {
    return str.split(',')[0].trim();
  }
  return str;
}

// Helper to parse CSV row into columns
function parseCSVRow(cellValue) {
  if (!cellValue) return ['', '', '', '', '', ''];
  const str = cellValue.toString().trim();
  const parts = str.split(',');
  return [
    parts[0]?.trim() || '',
    parts[1]?.trim() || '',
    parts[2]?.trim() || '',
    parts[3]?.trim() || '',
    parts[4]?.trim() || '',
    parts[5]?.trim() || ''
  ];
}

// Find invite code row in Excel
async function findInviteCodeInExcel(code) {
  const codeTrimmed = code.trim().toLowerCase();
  console.log(`[excel] Searching for code: "${codeTrimmed}"`);
  
  const rows = await getExcelTableRows();
  if (!rows) {
    console.error('[excel] Failed to get Excel table rows');
    return null;
  }
  
  if (!rows.length) {
    console.warn('[excel] Excel table is empty or no rows found');
    return null;
  }
  
  console.log(`[excel] Found ${rows.length} rows in Excel table`);
  
  // Find row where first column (code) matches
  // Note: Excel table rows may include header row, so we check all rows
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const values = row.values || [];
    const firstCell = values[0] ? values[0].toString().trim() : '';
    
    // Skip header row if it contains "code" as first value
    if (i === 0 && firstCell.toLowerCase().includes('code')) {
      console.log('[excel] Skipping header row');
      continue;
    }
    
    // Extract code from cell (handles CSV format)
    const rowCode = extractCodeFromCell(firstCell).toLowerCase();
    
    if (rowCode && rowCode === codeTrimmed) {
      console.log(`[excel] Found matching code at row index ${row.index}`);
      
      // Parse the row - if first cell contains CSV, parse it; otherwise use values array
      let parsedValues;
      if (firstCell.includes(',')) {
        // CSV format - parse the first cell
        parsedValues = parseCSVRow(firstCell);
      } else {
        // Normal format - use values array
        parsedValues = [
          values[0] || '',
          values[1] || '',
          values[2] || '',
          values[3] || '',
          values[4] || '',
          values[5] || ''
        ];
      }
      
      return {
        index: row.index,
        values: parsedValues,
        code: parsedValues[0],
        assignedTo: parsedValues[1],
        usedBy: parsedValues[2],
        usedAt: parsedValues[3],
        referrer: parsedValues[4],
        notes: parsedValues[5]
      };
    }
  }
  
  console.warn(`[excel] Code "${codeTrimmed}" not found in Excel table`);
  // Log first few codes for debugging
  if (rows.length > 0) {
    const sampleCodes = rows.slice(0, 3).map(r => {
      const v = r.values || [];
      const firstCell = v[0] ? v[0].toString().trim() : '';
      return extractCodeFromCell(firstCell);
    });
    console.log(`[excel] Sample codes in Excel: ${sampleCodes.join(', ')}`);
  }
  
  return null;
}

// Find an invite code row in Excel by the wallet that used it
async function findInviteUsageByAddress(address) {
  const checksumAddr = normalizeHexAddress(address);
  if (!checksumAddr) return null;

  const target = normalizeAddress(checksumAddr);
  const rows = await getExcelTableRows();
  if (!rows || !rows.length) {
    return null;
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const values = row.values || [];
    const firstCell = values[0] ? values[0].toString().trim() : '';

    // Skip header row if present
    if (i === 0 && firstCell.toLowerCase().includes('code')) {
      continue;
    }

    let parsedValues;
    if (firstCell.includes(',')) {
      parsedValues = parseCSVRow(firstCell);
    } else {
      parsedValues = [
        values[0] || '',
        values[1] || '',
        values[2] || '',
        values[3] || '',
        values[4] || '',
        values[5] || ''
      ];
    }

    const usedByCell = parsedValues[2] ? parsedValues[2].toString().trim() : '';
    if (!usedByCell) continue;

    const normalizedUsedBy = normalizeHexAddress(usedByCell);
    if (normalizedUsedBy && normalizeAddress(normalizedUsedBy) === target) {
      return {
        index: row.index,
        code: parsedValues[0],
        assignedTo: parsedValues[1],
        usedBy: normalizeAddress(normalizedUsedBy),
        usedAt: parsedValues[3],
        referrer: parsedValues[4],
        notes: parsedValues[5]
      };
    }
  }

  return null;
}

// Update a row in Excel table
async function updateExcelTableRow(rowIndex, values) {
  if (!MS_EXCEL_FILE_ID) return false;
  const token = await getMsGraphAccessToken();
  if (!token) return false;
  try {
    const base = getExcelApiBase();
    if (!base) return false;
    const url = `${base}/workbook/worksheets('${encodeURIComponent(
      MS_EXCEL_WORKSHEET_NAME
    )}')/tables('${encodeURIComponent(MS_EXCEL_TABLE_NAME)}')/rows/itemAt(index=${rowIndex})`;
    
    const resp = await fetch(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values: [values] })
    });

    if (!resp.ok) {
      const text = await resp.text();
      console.error('[excel] Failed to update row:', resp.status, text);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[excel] Error updating row:', err.message || err);
    return false;
  }
}

// Log redemption to Excel - updates the invite row with redemption info
async function logRedemptionToExcel({ code, referrer, referred }) {
  const row = await findInviteCodeInExcel(code);
  if (!row) {
    console.error('[excel] Code not found for redemption:', code);
    return false;
  }
  
  const timestampIso = new Date().toISOString();
  const redemptionNote = referrer 
    ? `Redeemed at ${timestampIso} - Referrer: ${referrer}, Referred: ${referred}`
    : `Redeemed at ${timestampIso} - Referred: ${referred}`;
  
  const updatedValues = [
    row.code,
    row.assignedTo,
    referred, // usedBy - the person who redeemed
    timestampIso, // usedAt - redemption timestamp
    referrer || row.referrer || '', // referrer - set if provided
    (row.notes ? row.notes + '; ' : '') + redemptionNote // notes - append redemption info
  ];
  
  const success = await updateExcelTableRow(row.index, updatedValues);
  if (!success) {
    console.error('[excel] Failed to update Excel row for redemption:', code);
  }
  return success;
}

async function logInviteToExcel({ referrer, newUser, code, inviteToken }) {
  // Legacy function - now we update the invite row directly
  const row = await findInviteCodeInExcel(code);
  if (!row) return;
  
  const timestampIso = new Date().toISOString();
  const updatedValues = [
    row.code,
    row.assignedTo,
    newUser,
    timestampIso,
    referrer || row.referrer,
    row.notes || `Invited at ${timestampIso}`
  ];
  
  await updateExcelTableRow(row.index, updatedValues);
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
// Debug endpoint to list invite codes from Excel (first 10)
app.get('/invite/debug', async (_req, res) => {
  try {
    if (!MS_EXCEL_FILE_ID) {
      return res.status(500).json({ error: 'excel_not_configured' });
    }
    
    const rows = await getExcelTableRows();
    if (!rows || !rows.length) {
      return res.json({ 
        error: 'no_rows_found',
        message: 'Excel table is empty or could not be read',
        rowCount: 0,
        codes: []
      });
    }
    
    // Extract codes from rows (skip header if present)
    const codes = [];
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const row = rows[i];
      const values = row.values || [];
      const firstCell = values[0] ? values[0].toString().trim() : '';
      
      // Skip header row
      if (i === 0 && firstCell.toLowerCase().includes('code')) {
        continue;
      }
      
      // Extract code and parse CSV if needed
      const code = extractCodeFromCell(firstCell);
      if (code) {
        let parsedValues;
        if (firstCell.includes(',')) {
          parsedValues = parseCSVRow(firstCell);
        } else {
          parsedValues = [
            values[0] || '',
            values[1] || '',
            values[2] || '',
            values[3] || '',
            values[4] || '',
            values[5] || ''
          ];
        }
        
        codes.push({
          code: parsedValues[0],
          assignedTo: parsedValues[1],
          usedBy: parsedValues[2],
          usedAt: parsedValues[3],
          referrer: parsedValues[4]
        });
      }
    }
    
    return res.json({
      success: true,
      rowCount: rows.length,
      sampleCodes: codes,
      excelConfig: {
        fileId: MS_EXCEL_FILE_ID,
        worksheetName: MS_EXCEL_WORKSHEET_NAME,
        tableName: MS_EXCEL_TABLE_NAME,
        userId: MS_USER_ID || 'not_set'
      }
    });
  } catch (e) {
    console.error('[invite/debug] Error:', e.message || e);
    return res.status(500).json({ error: e.message });
  }
});

// Check if a user address has already used an invite code (Excel lookup)
app.get('/invite/status/:address', async (req, res) => {
  try {
    const { address } = req.params || {};
    const checksumAddr = normalizeHexAddress(address);
    if (!checksumAddr) {
      return res.status(400).json({ error: 'valid address required' });
    }

    if (!MS_EXCEL_FILE_ID) {
      return res.status(500).json({ error: 'excel_not_configured' });
    }

    const normalized = normalizeAddress(checksumAddr);
    const inviteRow = await findInviteUsageByAddress(normalized);

    if (!inviteRow) {
      return res.json({
        address: normalized,
        hasUsedInvite: false,
        invite: null
      });
    }

    return res.json({
      address: normalized,
      hasUsedInvite: true,
      invite: {
        code: inviteRow.code,
        assignedTo: inviteRow.assignedTo,
        usedBy: inviteRow.usedBy,
        usedAt: inviteRow.usedAt,
        referrer: inviteRow.referrer,
        notes: inviteRow.notes
      }
    });
  } catch (e) {
    console.error('[invite/status] Error:', e.message || e);
    return res.status(500).json({ error: e.message });
  }
});

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

      const planMonthlyCap = subscriptionEffectiveCap(subscription);
      const planId = Number(subscription.planId);
      const used = Number(subscription.usedThisWindow ?? 0);
      const isPriceAccuracyMode = normalizedMode === 'price_accuracy' || normalizedMode === 'full';
      const effectiveCap = isPriceAccuracyMode ? Math.min(Number(oracle.GLOBAL_PRICE_ACCURACY_CAP), planMonthlyCap) : planMonthlyCap;

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
      // BUT: Always allow decreases (when remainingValue < currentRemaining) - this is legitimate usage
      if (inferenceStore && inferenceStore.getRemaining) {
        try {
          const currentStored = await inferenceStore.getRemaining(normalizedAddress, normalizedMode);
          if (currentStored && currentStored.remaining !== undefined && currentStored.remaining !== null) {
            const currentRemaining = Number(currentStored.remaining);
            const quantityNum = Number(quantity || 0);
            
            // Only prevent if trying to increase AND plan hasn't changed
            // Decreases are always allowed (legitimate usage)
            if (remainingValue > currentRemaining && currentStored.planId === planId) {
              console.warn(`[recordInferenceUsageSnapshot] Prevented remaining increase: current=${currentRemaining}, attempted=${remainingValue} for ${normalizedAddress} mode=${normalizedMode}`);
              // Use current value instead - but this should rarely happen
              remainingValue = currentRemaining;
            }
            // If remainingValue equals currentRemaining but we have quantity > 0, we should still decrease
            // This handles the case where the override value wasn't calculated correctly
            else if (remainingValue === currentRemaining && quantityNum > 0 && currentStored.planId === planId) {
              console.warn(`[recordInferenceUsageSnapshot] Remaining not decreasing despite quantity > 0: current=${currentRemaining}, quantity=${quantityNum}, forcing decrease for ${normalizedAddress} mode=${normalizedMode}`);
              remainingValue = Math.max(0, currentRemaining - quantityNum);
            }
            // Explicitly allow decreases (remainingValue < currentRemaining) - no action needed
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

// Tiny per-process TTL caches to avoid duplicate lookups during bursts
const PENDING_CACHE_TTL_MS = 4_000;
const pendingUsageCache = new Map();
const pendingCreditsCache = new Map();
const pendingEngagementCache = new Map();
const pendingCalculatedCache = new Map();

function getCachedValue(cache, key, loader, ttl = PENDING_CACHE_TTL_MS) {
  const existing = cache.get(key);
  if (existing) {
    const age = Date.now() - existing.ts;
    if (age < ttl) return existing.value;
    // If a promise is still in-flight, reuse it
    if (existing.value && typeof existing.value.then === 'function') {
      return existing.value;
    }
  }
  const promise = Promise.resolve()
    .then(loader)
    .then(val => {
      cache.set(key, { ts: Date.now(), value: val });
      return val;
    })
    .catch(err => {
      cache.delete(key);
      throw err;
    });
  cache.set(key, { ts: Date.now(), value: promise });
  return promise;
}

function pendingUsageCacheKey(user, subscription) {
  const planId = subscription ? Number(subscription.planId ?? subscription[0] ?? 0) : 0;
  return `${user.toLowerCase()}|${planId}`;
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
    
    // For subscription-based inference, all modes share the same pool, so always check 'general' mode
    // This ensures we find the cached remaining count regardless of the specific mode requested
    const cacheLookupMode = 'general';
    const stored = await getStoredRemainingInference(normalizedAddress, cacheLookupMode);
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
      const planMonthlyCap = subscriptionEffectiveCap(subscription);
      
      if (planChanged && planMonthlyCap > 0) {
        // Plan changed: reset to new plan's full cap (base + rollover already computed)
        baseline = planMonthlyCap;
      } else {
        // Cache miss: fetch actual on-chain state (includes window reset logic)
        // Use 'general' mode for on-chain lookup since all modes share the same subscription pool
        const onchainRemaining = Number(await getOracle().getRemainingInference(user, 'general'));
        
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
    
    // If we have a valid cached value, ALWAYS use it as baseline (it's the most accurate)
    // This ensures we're always working from the correct starting point
    if (stored && stored.remaining !== undefined && stored.remaining !== null && planMatches) {
      const cachedRemaining = Number(stored.remaining);
      baseline = cachedRemaining; // Use cached value as baseline
    }
    
    const quantityNum = Number(quantity || 0);
    const nextRemaining = Math.max(baseline - quantityNum, 0);

    // Safeguard: Never increase remaining count - it should only decrease
    // This should rarely trigger now since we're using cached value as baseline
    let finalRemaining = nextRemaining;
    if (stored && stored.remaining !== undefined && stored.remaining !== null && planMatches) {
      const cachedRemaining = Number(stored.remaining);
      console.log(`[cacheAuthorizationUsage] Deducting inference: user=${user}, mode=${normalizedMode}, cachedRemaining=${cachedRemaining}, baseline=${baseline}, quantity=${quantityNum}, nextRemaining=${nextRemaining}`);
      
      // If calculated nextRemaining is higher than cached, something is wrong
      // This means baseline was calculated incorrectly (too high)
      if (nextRemaining > cachedRemaining) {
        // Recalculate from cached value instead
        finalRemaining = Math.max(0, cachedRemaining - quantityNum);
        console.warn(`[cacheAuthorizationUsage] Prevented remaining increase: cached=${cachedRemaining}, calculated=${nextRemaining}, corrected=${finalRemaining} for ${user}`);
      }
      // If nextRemaining equals cachedRemaining and quantity > 0, something is wrong
      else if (nextRemaining === cachedRemaining && quantityNum > 0) {
        // Force decrease from cached value
        finalRemaining = Math.max(0, cachedRemaining - quantityNum);
        console.warn(`[cacheAuthorizationUsage] Fixed remaining not decreasing: cached=${cachedRemaining}, quantity=${quantityNum}, corrected=${finalRemaining} for ${user}`);
      }
      
      // Ensure we actually decreased if quantity > 0
      if (quantityNum > 0 && finalRemaining >= cachedRemaining) {
        console.error(`[cacheAuthorizationUsage] ERROR: Remaining did not decrease! cached=${cachedRemaining}, finalRemaining=${finalRemaining}, quantity=${quantityNum} for ${user}`);
        // Force decrease
        finalRemaining = Math.max(0, cachedRemaining - quantityNum);
      }
    }
    
    console.log(`[cacheAuthorizationUsage] Final remaining after deduction: ${finalRemaining} for ${user}, quantity=${quantityNum}`);

    let earnedCreditsDelta = 0;
    const planMonthlyCap = subscriptionEffectiveCap(subscription);
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

// Authorization check only (reads on-chain state, no state updates)
// Called before submitting query to AI MCP server
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

    // Kick off all the expensive lookups in parallel to reduce latency
    const subscriptionPromise = getOracle().getUserSubscription(checksumUser).catch(err => {
      console.error('[authorize] Error fetching subscription:', err.message || err);
      return null;
    });

    const pendingUsagePromise = subscriptionPromise.then(subscription =>
      getCachedValue(
        pendingUsageCache,
        pendingUsageCacheKey(checksumUser, subscription),
        async () => {
      if (subscription && Number(subscription.planId) > 0 && subscription.plan?.active) {
        const normalizedAddress = normalizeAddress(checksumUser);
        const cacheLookupMode = 'general';
        const stored = await getStoredRemainingInference(normalizedAddress, cacheLookupMode);
        
        const currentPlanId = Number(subscription.planId);
        const cachedPlanId = stored?.planId;
        if (stored && stored.remaining !== undefined && stored.remaining !== null &&
            cachedPlanId !== null && cachedPlanId === currentPlanId) {
              const monthlyCap = subscriptionEffectiveCap(subscription);
          const onChainUsed = Number(subscription.usedThisWindow);
          const remainingFromNeo4j = Number(stored.remaining);
          const totalUsedFromNeo4j = monthlyCap - remainingFromNeo4j;
              return Math.max(0, totalUsedFromNeo4j - onChainUsed);
        }
      }
          return 0;
        }
      )
    );

    const pendingCreditsPromise = getCachedValue(
      pendingCreditsCache,
      checksumUser.toLowerCase(),
      () => getPendingCreditUsage(checksumUser)
    );

    const pendingEngagementPromise = getCachedValue(
      pendingEngagementCache,
      checksumUser.toLowerCase(),
      () => getPendingEngagementCredits(checksumUser)
    );

    const pendingCalculatedPromise = getCachedValue(
      pendingCalculatedCache,
      checksumUser.toLowerCase(),
      async () => {
      if (engagementStore && engagementStore.getCalculatedCreditsForUser) {
        const normalizedAddress = normalizeAddress(checksumUser);
        const calculated = await engagementStore.getCalculatedCreditsForUser(normalizedAddress);
          return Number(calculated?.totalCalculatedCredits || 0);
      }
        return 0;
      }
    );

    const [
      _subscriptionUnused,
      pendingUsageFromNeo4j,
      pendingCreditsFromNeo4j,
      pendingEngagementFromNeo4j,
      pendingCalculatedFromNeo4j
    ] = await Promise.all([
      subscriptionPromise,
      pendingUsagePromise,
      pendingCreditsPromise,
      pendingEngagementPromise,
      pendingCalculatedPromise
    ]);

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

    // Authorization check only - no state updates
    // State updates should be done via /inference/record after successful AI inference
    return res.json(serialize({
      ...result,
      mode: resolvedMode,
      contextHash: contextHashValue
    }));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// Record inference usage and update off-chain state (billing, over-spending prevention, state updates)
// Called after successful AI inference response
// body: { user: string, mode?: string, quantity?: number, contextHash?: string, reason?: string, tags?: boolean }
app.post('/inference/record', async (req, res) => {
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

    // Calculate all pending values in parallel to cut request latency
    const subscriptionPromise = getOracle().getUserSubscription(checksumUser).catch(err => {
      console.error('[record] Error fetching subscription:', err.message || err);
      return null;
    });

    const pendingUsagePromise = subscriptionPromise.then(subscription =>
      getCachedValue(
        pendingUsageCache,
        pendingUsageCacheKey(checksumUser, subscription),
        async () => {
      if (subscription && Number(subscription.planId) > 0 && subscription.plan?.active) {
        const normalizedAddress = normalizeAddress(checksumUser);
        const cacheLookupMode = 'general';
        const stored = await getStoredRemainingInference(normalizedAddress, cacheLookupMode);
        
        const currentPlanId = Number(subscription.planId);
        const cachedPlanId = stored?.planId;
        if (stored && stored.remaining !== undefined && stored.remaining !== null &&
            cachedPlanId !== null && cachedPlanId === currentPlanId) {
              const monthlyCap = subscriptionEffectiveCap(subscription);
          const onChainUsed = Number(subscription.usedThisWindow);
          const remainingFromNeo4j = Number(stored.remaining);
          const totalUsedFromNeo4j = monthlyCap - remainingFromNeo4j;
              return Math.max(0, totalUsedFromNeo4j - onChainUsed);
        }
      }
          return 0;
        }
      )
    );

    const pendingCreditsPromise = getCachedValue(
      pendingCreditsCache,
      checksumUser.toLowerCase(),
      () => getPendingCreditUsage(checksumUser)
    );

    const pendingEngagementPromise = getCachedValue(
      pendingEngagementCache,
      checksumUser.toLowerCase(),
      () => getPendingEngagementCredits(checksumUser)
    );

    const pendingCalculatedPromise = getCachedValue(
      pendingCalculatedCache,
      checksumUser.toLowerCase(),
      async () => {
      if (engagementStore && engagementStore.getCalculatedCreditsForUser) {
        const normalizedAddress = normalizeAddress(checksumUser);
        const calculated = await engagementStore.getCalculatedCreditsForUser(normalizedAddress);
          return Number(calculated?.totalCalculatedCredits || 0);
      }
        return 0;
      }
    );

    const [
      _subscriptionUnused,
      pendingUsageFromNeo4j,
      pendingCreditsFromNeo4j,
      pendingEngagementFromNeo4j,
      pendingCalculatedFromNeo4j
    ] = await Promise.all([
      subscriptionPromise,
      pendingUsagePromise,
      pendingCreditsPromise,
      pendingEngagementPromise,
      pendingCalculatedPromise
    ]);

    // Re-check authorization to prevent race conditions and determine billing method
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

    // If not allowed, return error (shouldn't happen if authorize was called first, but safety check)
    if (!result?.allowed) {
      return res.status(403).json(serialize({
        error: 'Inference not authorized',
        ...result,
        mode: resolvedMode,
        contextHash: contextHashValue
      }));
    }

    // Update off-chain state based on billing method
    if (result.method === 'subscription') {
      await cacheAuthorizationUsage({
        user: checksumUser,
        mode: resolvedMode,
        quantity: numericQuantity,
        method: result.method,
        contextHash: contextHashValue,
        reason: reasonValue
      });
    } else if (result.method === 'credits') {
      await cacheCreditAuthorization({
        user: checksumUser,
        cost: result.cost,
        contextHash: contextHashValue,
        reason: reasonValue
      });
    }
    // Note: 'initial_grant' method doesn't need state update (handled on-chain later)

    return res.json(serialize({
      success: true,
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
// Automatically fetches fresh subscription data when missing to catch recent purchases
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

    // If subscription is null or empty object, automatically fetch fresh data to catch recent purchases
    let finalSubscription = subscription;
    if (!subscription || (typeof subscription === 'object' && Object.keys(subscription).length === 0)) {
      // Subscription appears missing - automatically fetch fresh from chain to catch recent purchases
      try {
        // Clear cache and fetch fresh
        getOracle().invalidateSubscriptionCache(checksumAddr);
        finalSubscription = await getOracle().getUserSubscription(checksumAddr);
      } catch (err) {
        console.error('[summary] error fetching fresh subscription after empty result', err.message || err);
        finalSubscription = subscription; // Fall back to original
      }
    }
    
    const planId = finalSubscription ? Number(finalSubscription.planId ?? finalSubscription[0] ?? 0) : 0;
    const hasActiveSub = !!finalSubscription && planId > 0 && finalSubscription.plan?.active;

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
      const subscriptionRenewedRecently = finalSubscription?.lastRenewedAt 
        ? (Date.now() / 1000 - Number(finalSubscription.lastRenewedAt)) < 300 // Within last 5 minutes
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
        const planMonthlyCap = subscriptionEffectiveCap(finalSubscription);
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
          remaining = subscriptionEffectiveCap(finalSubscription);
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

    // Calculate pending values for response (credits are separate from inference)
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
      subscription: finalSubscription || {},
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

// Validate invite code from Excel and assign to a new user
// Can be called directly from frontend
// body: { code: string, newUser: string }
app.post('/invite', async (req, res) => {
  try {
    const { code, newUser } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'code required' });
    }
    const checksumNewUser = normalizeHexAddress(newUser);
    if (!checksumNewUser) {
      return res.status(400).json({ error: 'valid newUser address required' });
    }

    // Check if Excel is configured
    if (!MS_EXCEL_FILE_ID) {
      return res.status(500).json({ error: 'excel_not_configured' });
    }

    const normalizedNew = normalizeAddress(checksumNewUser);
    const codeTrimmed = code.trim();

    // Check if code exists in Excel - MUST exist before proceeding
    const excelRow = await findInviteCodeInExcel(codeTrimmed);
    if (!excelRow) {
      return res.status(400).json({ error: 'invalid_code_not_found_in_excel' });
    }

    // Check if code is already used
    if (excelRow.usedBy && excelRow.usedBy.trim()) {
      return res.status(400).json({ error: 'code_already_used' });
    }

    // Check if code is assigned to a specific user and validate
    if (excelRow.assignedTo && excelRow.assignedTo.trim()) {
      const assignedAddr = normalizeHexAddress(excelRow.assignedTo.trim());
      if (!assignedAddr || normalizeAddress(assignedAddr) !== normalizedNew) {
        return res.status(403).json({ error: 'code_not_assigned_to_this_user' });
      }
    }

    // Mark code as used in Excel
    const timestampIso = new Date().toISOString();
    const updatedValues = [
      excelRow.code,
      excelRow.assignedTo,
      normalizedNew, // usedBy
      timestampIso, // usedAt
      excelRow.referrer,
      excelRow.notes || `Invited at ${timestampIso}`
    ];
    
    const updated = await updateExcelTableRow(excelRow.index, updatedValues);
    if (!updated) {
      console.error('[invite] Failed to update Excel row for code:', codeTrimmed);
      return res.status(500).json({ error: 'failed_to_update_invite_code' });
    }

    return res.json(serialize({
      code: codeTrimmed,
      newUser: normalizedNew,
      referrer: excelRow.referrer || '',
      usedAt: timestampIso
    }));
  } catch (e) {
    console.error('[invite] Error:', e.message || e);
    return res.status(500).json({ error: e.message });
  }
});

// Redeem a referral code (ASV-XXX format) AND invite code (Excel) for a new user
// Requires BOTH: referral code from Neo4j (user A's code) AND invite code from Excel
app.post('/referral/redeem', async (req, res) => {
  try {
    const { code, inviteCode, newUser } = req.body || {};
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'referral_code_required' });
    }
    if (typeof inviteCode !== 'string' || !inviteCode.trim()) {
      return res.status(400).json({ error: 'invite_code_required' });
    }
    const checksumNewUser = normalizeHexAddress(newUser);
    if (!checksumNewUser) return res.status(400).json({ error: 'valid newUser address required' });
    if (!referralStore) return res.status(500).json({ error: 'referral store not configured' });

    const normalizedNew = normalizeAddress(checksumNewUser);
    const referralCodeTrimmed = code.trim();
    const inviteCodeTrimmed = inviteCode.trim();

    // Step 1: Check and validate invite code in Excel
    if (!MS_EXCEL_FILE_ID) {
      return res.status(500).json({ error: 'excel_not_configured' });
    }
    
    const excelRow = await findInviteCodeInExcel(inviteCodeTrimmed);
    if (!excelRow) {
      return res.status(400).json({ error: 'invalid_invite_code_not_found_in_excel' });
    }

    // Check if code is already used by someone else
    if (excelRow.usedBy && excelRow.usedBy.trim() && excelRow.usedBy.trim() !== normalizedNew) {
      return res.status(400).json({ error: 'invite_code_already_used_by_another_user' });
    }

    // Check if code is assigned to a specific user and validate
    if (excelRow.assignedTo && excelRow.assignedTo.trim()) {
      const assignedAddr = normalizeHexAddress(excelRow.assignedTo.trim());
      if (!assignedAddr || normalizeAddress(assignedAddr) !== normalizedNew) {
        return res.status(403).json({ error: 'invite_code_not_assigned_to_this_user' });
      }
    }

    // If invite code is not yet used, mark it as used now
    if (!excelRow.usedBy || !excelRow.usedBy.trim()) {
      const timestampIso = new Date().toISOString();
      const updatedValues = [
        excelRow.code,
        excelRow.assignedTo,
        normalizedNew, // usedBy
        timestampIso, // usedAt
        excelRow.referrer,
        excelRow.notes || `Invited at ${timestampIso}`
      ];
      
      const updated = await updateExcelTableRow(excelRow.index, updatedValues);
      if (!updated) {
        console.error('[referral/redeem] Failed to update Excel row for invite code:', inviteCodeTrimmed);
        return res.status(500).json({ error: 'failed_to_update_invite_code' });
      }
      console.log(`[referral/redeem] Marked invite code ${inviteCodeTrimmed} as used by ${normalizedNew}`);
    }

    // Step 2: Find referrer by referral code in Neo4j
    // Referral codes are in format ASV-XXXXXX and stored in Neo4j
    const session = referralStore.driver.session();
    let referrerAddr = null;
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          MATCH (referrer:User)-[:HAS_REFERRAL_CODE]->(c:ReferralCode {code: $code})
          RETURN referrer.address AS referrerAddress
          `,
          { code: referralCodeTrimmed }
        )
      );
      
      if (result.records.length === 0) {
        return res.status(400).json({ error: 'invalid_referral_code_not_found' });
      }
      
      referrerAddr = normalizeAddress(result.records[0].get('referrerAddress'));
    } catch (err) {
      console.error('[referral/redeem] Error finding referral code:', err.message || err);
      return res.status(500).json({ error: 'failed_to_lookup_referral_code' });
    } finally {
      await session.close();
    }

    if (!referrerAddr) {
      return res.status(400).json({ error: 'referrer_not_found_for_code' });
    }

    // Normalize referrer address
    const normalizedReferrer = normalizeAddress(referrerAddr);

    if (normalizedReferrer.toLowerCase() === normalizedNew.toLowerCase()) {
      return res.status(400).json({ error: 'self_referral_not_allowed' });
    }

    // Check if referral relationship already exists in Neo4j
    const sessionCheck = referralStore.driver.session();
    let referralExists = false;
    try {
      const checkResult = await sessionCheck.executeRead(tx =>
        tx.run(
          `
          MATCH (referrer:User {address: $referrer})-[r:REFERRED]->(newUser:User {address: $newUser})
          RETURN r
          `,
          { referrer: normalizedReferrer, newUser: normalizedNew }
        )
      );
      referralExists = checkResult.records.length > 0;
    } catch (err) {
      console.error('[referral/redeem] Error checking existing referral:', err.message || err);
    } finally {
      await sessionCheck.close();
    }
    
    if (referralExists) {
      return res.status(400).json({ error: 'referral_already_exists' });
    }

    // Check if referrer has allowed this new user (allow-list check)
    const isAllowed = await referralStore.isAllowedReferral(normalizedReferrer, normalizedNew);
    if (!isAllowed) {
      return res.status(400).json({ error: 'referral_not_allowed_by_referrer' });
    }

    // Create referral relationship in Neo4j
    const session2 = referralStore.driver.session();
    try {
      await session2.executeWrite(tx =>
        tx.run(
          `
          MERGE (referrer:User {address: $referrer})
          MERGE (newUser:User {address: $newUser})
          MERGE (referrer)-[r:REFERRED]->(newUser)
          ON CREATE SET r.createdAtMs = timestamp()
          RETURN r
          `,
          { referrer: normalizedReferrer, newUser: normalizedNew }
        )
      );
    } catch (err) {
      console.error('[referral/redeem] Error creating referral relationship:', err.message || err);
      // Continue anyway - we'll still credit the users
    } finally {
      await session2.close();
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
      address: normalizedReferrer,
      action: 'referral_you_refer',
      credits: refCredits,
      xp: refCredits * 2,
      metadata: { referred: normalizedNew, referralCode: referralCodeTrimmed, inviteCode: inviteCodeTrimmed },
      createdAt: now
    };

    const newEngagement = {
      id: randomUUID(),
      address: normalizedNew,
      action: 'referral_you_are_referred',
      credits: referredCredits,
      xp: referredCredits * 2,
      metadata: { referrer: normalizedReferrer, referralCode: referralCodeTrimmed, inviteCode: inviteCodeTrimmed },
      createdAt: now
    };

    const [refResult, newResult] = await Promise.all([
      engagementStore.recordEngagement(refEngagement),
      engagementStore.recordEngagement(newEngagement)
    ]);

    // Update Excel with redemption info - set referrer address from referral code
    const excelRowForUpdate = await findInviteCodeInExcel(inviteCodeTrimmed);
    if (excelRowForUpdate) {
      const timestampIso = new Date().toISOString();
      const redemptionNote = `Redeemed at ${timestampIso} - Referrer: ${normalizedReferrer}, Referred: ${normalizedNew}`;
      
      const updatedValues = [
        excelRowForUpdate.code,
        excelRowForUpdate.assignedTo,
        normalizedNew, // usedBy
        timestampIso, // usedAt (redemption timestamp)
        normalizedReferrer, // referrer - set from referral code
        (excelRowForUpdate.notes ? excelRowForUpdate.notes + '; ' : '') + redemptionNote
      ];
      
      const excelUpdated = await updateExcelTableRow(excelRowForUpdate.index, updatedValues);
      if (!excelUpdated) {
        console.warn('[referral/redeem] Failed to update Excel for invite code:', inviteCodeTrimmed);
      } else {
        console.log(`[referral/redeem] Updated Excel row for invite code ${inviteCodeTrimmed} with referrer ${normalizedReferrer}`);
      }
    }

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
    console.error('[referral/redeem] Error:', e.message || e);
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
