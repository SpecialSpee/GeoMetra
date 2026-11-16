// ============================================================
// 00-utils.js — Фундамент: RingBuffer, скелет GnnAI
// ============================================================
"use strict";

if (window.GnnAI) {
  console.warn("[GnnAI] уже загружен");
} else {
  window.GnnAI = {};
}

// === RingBuffer (кольцевой буфер для replay) ===
class RingBuffer {
  constructor(capacity) {
    this.capacity = capacity;
    this.buffer = new Array(capacity);
    this.head = 0;
    this.size = 0;
  }
  push(item) {
    this.buffer[this.head] = item;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }
  get length() { return this.size; }
  getRandom() {
    if (this.size === 0) return null;
    const idx = Math.floor(Math.random() * this.size);
    return this.buffer[(this.head - this.size + idx + this.capacity) % this.capacity];
  }
}

// === БЕЗОПАСНОЕ ИСПОЛЬЗОВАНИЕ ГЛОБАЛЬНЫХ КОНСТАНТ ===
// (Они ДОЛЖНЫ быть определены в constants.js ДО этого файла)
if (typeof G_ACTIONS === 'undefined') {
  console.error("[GnnAI] ❌ КРИТИЧЕСКАЯ ОШИБКА: G_ACTIONS не определен! Убедитесь, что constants.js загружен ДО gnnAI/00-utils.js");
}
if (typeof THREAT_ASSESSMENT === 'undefined') {
  console.error("[GnnAI] ❌ КРИТИЧЕСКАЯ ОШИБКА: THREAT_ASSESSMENT не определен! Убедитесь, что constants.js загружен ДО gnnAI/00-utils.js");
}
if (typeof CFG === 'undefined') {
  console.error("[GnnAI] ❌ КРИТИЧЕСКАЯ ОШИБКА: CFG не определен! Убедитесь, что constants.js загружен ДО gnnAI/00-utils.js");
}

const AIDX = Object.fromEntries(G_ACTIONS.map((a, i) => [a, i]));

// === Экспортируем вспомогалки для других модулей ===
window.GnnAI._RingBuffer = RingBuffer;
window.GnnAI._AIDX = AIDX;
window.GnnAI._THREAT_ASSESSMENT = THREAT_ASSESSMENT;
window.GnnAI._G_ACTIONS = G_ACTIONS;

// === Заполняем скелет GnnAI ===
Object.assign(window.GnnAI, {
  lastReconDiscoveryCheck: 0,
  lastTechStagnationCheck: 0,
  lastReplayEntry: null,
  _pendingShaped: 0,
  cfg: CFG, // Берём из глобального CFG
  actions: G_ACTIONS,
  model: null,
  optimizer: null,
  vars: [],
  targetVars: null,
  tau: 0.005,
  replay: new RingBuffer(CFG.REPLAY_SIZE),
  pending: [],
  initialized: false,
  training: false,
  isSaving: false,
  trainBatches: 0,
  lastTick: {},
  lastState: null,
  lastAction: null,
  episode: null,
  episodeReport: null,
  episodeAchievements: null,
  lastPhaseCheck: 0,
  strategicMemory: {
    enemyComposition: {},
    threatLevel: 0,
    lastTechLevel: 1,
    techProgressionTime: 0
  },
  missionCache: [],
  reconMemory: new Map(),
  MAX_MEMORY_AGE: 60000,
  lastStagnationCheck: 0,
  lastBuildingBuilt: {},
  lastArmySize: 0,
  lastBuildingCount: 0,
  lastResourceTotal: 0,
  lastEcoEffCheck: 0,
  lastResourceControlCheck: 0,
  _lastOutpostCount: 0,
  lastTechLevel: 1,
  lastReconCheck: 0,
  lastArmyActivityCheck: 0,
  lastCombatEfficiencyCheck: 0,
  lastTargetSelectionCheck: 0,
  _lastAttackTargets: [],
  _lastKillCount: 0,
  _lastDeathCount: 0,
  _lastDamageDealt: 0,
  _lastDamageTaken: 0,
  _lastCombatCheckTime: 0,
  _lastArmyPositions: null,
  lastExpansionCheck: 0,
  lastStrategicChangeTime: 0,
  lastStrategicAction: null,
  lastEcoCheck: 0,
  lastMilitaryCheck: 0,
  lastGapCheck: 0,
  bcActive: true,
  bcBatchCount: 0,
  curriculumTier: 0,
  episodesInCurrentTier: 0,
  TIER_THRESHOLD: 3,
  tierGoalsMet: { barracks: false, base2: false, base3: false },
  showWeightStats: false,
  sessionStartL2: 0,
  lastWeightSnapshot: null,
  currentWeightStats: null,
  lastStatsUpdate: 0,
  db: null,
  PREREQUISITES: {
    "turret": "barracks",
    "turret2": "barracks2",
    "turret3": "barracks3",
    "barracks2": "base2",
    "barracks3": "base3",
    "base2": "barracks",
    "base3": "barracks2"
  },
  BUILD_BONUSES: {
    "barracks": 25.0, "base2": 150.0, "barracks2": 60.0,
    "base3": 200.0, "barracks3": 80.0
  },
  BUILD_TIER_GOALS: {
    "barracks": "barracks", "base2": "base2", "base3": "base3"
  }
});