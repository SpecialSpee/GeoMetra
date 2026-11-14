// ============================================================
// entities.js — Классы игровых объектов
// Здесь только данные (свойства), никакой логики и отрисовки.
// ============================================================

// Счётчик уникальных ID зданий (локальный для этого модуля)
let buildingIdCounter = 0;

function generateUniqueBuildingId() {
  return 'building_' + (buildingIdCounter++);
}

// ------------------------------------------------------------
// Класс Building
// ------------------------------------------------------------
class Building {
  constructor(type, owner, x, y) {
    this.id = generateUniqueBuildingId();
    this.type = type;
    this.owner = owner;
    this.x = x;
    this.y = y;

    this.active = false;
    this.builtAt = performance.now();

    // === Размеры, здоровье и специфичные поля по типу ===
    if (type === "warehouse") {
      this.width = 40; this.height = 30;
      this.workers = 0;
      this.health = 1500; this.maxHealth = 1500;
      this.currentDeliveryWorkers = 0;
      this.maxDeliveryWorkers = 5;
    }
    else if (type === "repairWorkshop") {
      this.width = 40; this.height = 30;
      this.health = 1600; this.maxHealth = 1600;
      this.capacity = 5;
      this.repairman = 0;
      this.controlRadius = 400;
    }
    else if (type === "barracks") {
      this.width = 50; this.height = 30;
      this.fighters = 0;
      this.health = 1800; this.maxHealth = 1800;
      this.productionQueue = [];
      this.productionLimit = 10;
      this.buildZoneMultiplier = 1.5;
    }
    else if (type === "barracks2") {
      this.width = 50; this.height = 30;
      this.fighters = 0;
      this.health = 2150; this.maxHealth = 2150;
      this.productionQueue = [];
      this.productionLimit = 5;
      this.buildZoneMultiplier = 1.5;
    }
    else if (type === "barracks3") {
      this.width = 50; this.height = 30;
      this.fighters = 0;
      this.health = 3900; this.maxHealth = 3900;
      this.productionQueue = [];
      this.productionLimit = 3;
      this.buildZoneMultiplier = 1.5;
    }
    else if (type === "base") {
      this.width = 60; this.height = 50;
      this.health = 2600; this.maxHealth = 2600;
      this.productionQueue = [];
      this.buildZoneMultiplier = 2;
    }
    else if (type === "base2") {
      this.width = 55; this.height = 40;
      this.health = 4500; this.maxHealth = 4500;
      this.buildZoneMultiplier = 2;
    }
    else if (type === "base3") {
      this.width = 55; this.height = 40;
      this.health = 8000; this.maxHealth = 8000;
      this.buildZoneMultiplier = 2;
    }
    else if (type === "turret") {
      this.width = 12; this.height = 12;
      this.health = 1900; this.maxHealth = 1900;
      this.range = 250; this.fireRate = 200;
      this.lastFireTime = 0; this.angle = 0;
      this.target = null;
      this.visionRadius = 290;
    }
    else if (type === "turret2") {
      this.width = 15; this.height = 17;
      this.health = 1200; this.maxHealth = 1200;
      this.range = 500; this.fireRate = 3000;
      this.lastFireTime = 0; this.angle = 0;
      this.target = null;
      this.visionRadius = 530;
    }
    else if (type === "turret3") {
      this.width = 14; this.height = 15;
      this.health = 1500; this.maxHealth = 1500;
      this.range = 450; this.fireRate = 1000;
      this.lastFireTime = 0; this.angle = 0;
      this.target = null;
      this.visionRadius = 500;
      this.lastTarget = null;
      this.alignmentAchievedAt = undefined;
      this.alignmentCounter = 0;
    }
    else if (type === "beacon") {
      this.width = 40; this.height = 50;
      this.health = 1650; this.maxHealth = 1650;
      this.buildZoneMultiplier = 4;
    }

    // === Стоимость и задержка активации ===
    switch (type) {
      case "warehouse":
        this.buildCost = { ...WAREHOUSE_COST };
        this.activationDelay = 5000;
        break;
      case "repairWorkshop":
        this.buildCost = { ...REPAIR_WORKSHOP_COST };
        this.activationDelay = 6000;
        break;
      case "barracks":
        this.buildCost = { ...BARRACKS_COST };
        this.activationDelay = 8000;
        break;
      case "barracks2":
        this.buildCost = { ...BARRACKS2_COST };
        this.activationDelay = 11000;
        break;
      case "barracks3":
        this.buildCost = { ...BARRACKS3_COST };
        this.activationDelay = 15000;
        break;
      case "turret":
        this.buildCost = { ...TURRET_COST };
        this.activationDelay = 7000;
        break;
      case "turret2":
        this.buildCost = { ...TURRET2_COST };
        this.activationDelay = 9000;
        break;
      case "turret3":
        this.buildCost = { ...TURRET3_COST };
        this.activationDelay = 11000;
        break;
      case "beacon":
        this.buildCost = { ...BEACON_COST };
        this.activationDelay = 8000;
        break;
      case "base":
        this.buildCost = { ...BASE_COST };
        this.activationDelay = 10000;
        break;
      case "base2":
        this.buildCost = { ...BASE2_COST };
        this.activationDelay = 17000;
        break;
      case "base3":
        this.buildCost = { ...BASE3_COST };
        this.activationDelay = 24000;
        break;
      default:
        this.buildCost = { gold: 0, silicon: 0, plasma: 0 };
        this.activationDelay = 3000;
    }
  }
}

// ------------------------------------------------------------
// Класс Unit
// ------------------------------------------------------------
class Unit {
  constructor(type, owner, x, y) {
    this.type = type;
    this.owner = owner;
    this.x = x;
    this.y = y;

    this.target = null;
    this.commandQueue = [];
    this.idleTimer = 0;
    this.currentMovementAnimation = null;
    this.angle = 0;
    this.scale = 1;
    this.hidden = false;
    this.hiding = false;
    this.inWorkshop = null;
    this.maneuvering = false;
    this.formationBuff = null;

    if (type === "worker") {
      this.vx = 0; this.vy = 0;
      this.health = 100; this.maxHealth = 100;
    }
    else if (type === "fighter") {
      this.vx = 0; this.vy = 0;
      this.health = 250; this.maxHealth = 250;
      this.range = 180;
      this.fireRate = 350;
      this.lastFireTime = 0;
      this.orbitRadius = undefined;
      this.orbitAngle = undefined;
      this.engagementRadius = 500;
    }
    else if (type === "repairman") {
      this.vx = 0; this.vy = 0;
      this.health = 150; this.maxHealth = 150;
      this.engagementRadius = 500;
      this.scale = 0.4;
    }
    else if (type === "assault") {
      this.vx = 0; this.vy = 0;
      this.health = 300; this.maxHealth = 300;
      this.machineGunRange = 200;
      this.machineGunFireRate = 250;
      this.lastMachineGunFireTime = 0;
      this.rocketRange = 280;
      this.rocketCooldown = 3000;
      this.lastRocketFireTime = performance.now();
      this.engagementRadius = 500;
      this.range = 280;
    }
    else if (type === "elite") {
      this.vx = 0; this.vy = 0;
      this.health = 750; this.maxHealth = 750;
      this.range = 500;
      this.meleeRange = 200;
      this.artilleryRange = 500;
      this.laserRange = 300;
      this.lastMeleeAttack = 0;
      this.lastArtilleryAttack = 0;
      this.lastLaserAttack = 0;
      this.meleeCooldown = 1000;
      this.artilleryCooldown = 10000;
      this.laserCooldown = 5000;
    }
  }
}

// ------------------------------------------------------------
// Класс Resource
// ------------------------------------------------------------
class Resource {
  constructor(type, x, y, amount, max) {
    this.type = type;
    this.x = x;
    this.y = y;
    this.amount = amount;
    this.max = max;
    this.currentWorkers = 0;
    this.maxWorkers = 10;
    this.depleted = false;

    if (this.type === "gold") {
      const shape = createGoldShape();
      this.points = shape.points;
      this.baseRadius = shape.baseRadius;
      this.rotation = 0;
      this.rotationSpeed = 0.2;
    }
  }
}

// ------------------------------------------------------------
// Класс Bullet
// ------------------------------------------------------------
class Bullet {
  constructor(x, y, angle, speed, shooter, target) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.speed = speed;
    this.shooter = shooter;
    this.target = target;
    this.alive = true;
    this.damage = 10;
    this.lifetime = 1.5;
  }
}