let saleTimeout = null;
let saleBuilding = null;
let saleStartTime = 0;

const saleDuration = 2000;
const saleMoveThreshold = 5;

let worldWidth, worldHeight;

// Инициализация Canvas и контекста (ЕДИНСТВЕННОЕ МЕСТО!)
const canvas = document.getElementById("gameCanvas");
const ctx = canvas.getContext("2d");

// Определяем, является ли устройство мобильным
const isMobile = /Mobi|Android/i.test(navigator.userAgent);

// Объект камеры и функции преобразования координат
const camera = {
  offsetX: 0,
  offsetY: 0,
  scale: 0.5
};

function worldToScreen(x, y) {
  return { x: x * camera.scale + camera.offsetX, y: y * camera.scale + camera.offsetY };
}

function screenToWorld(x, y) {
  return { x: (x - camera.offsetX) / camera.scale, y: (y - camera.offsetY) / camera.scale };
}

function getDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function lerpAngle(a, b, t) {
  const diff = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + diff * t;
}

function easeOutQuad(t) {
  return t * (2 - t);
}

function getRandomTargetPoint(centerX, centerY, radius) {
  const angle = Math.random() * 4 * Math.PI;
  const r = Math.random() * radius;
  return { x: centerX + r * Math.cos(angle), y: centerY + r * Math.sin(angle) };
}

function createGoldShape() {
  const numPoints = 8;
  const baseRadius = 7;
  const points = [];
  for (let i = 0; i < numPoints; i++) {
    const angle = (i / numPoints) * Math.PI * 2;
    const offset = (Math.random() - 0.5) * 4;
    const r = baseRadius + offset;
    points.push({ x: r * Math.cos(angle), y: r * Math.sin(angle) });
  }
  return { points, baseRadius };
}

function getObjectsInRange(pos, range) {
  const queryRect = { x: pos.x - range, y: pos.y - range, width: range * 2, height: range * 2 };
  return quadtree ? quadtree.query(queryRect) : [];
}

function getEnemiesInRange(pos, range, shooterOwner) {
  return getObjectsInRange(pos, range).filter(obj =>
    (obj.health !== undefined) && (obj.health > 0) &&
    (obj.owner !== shooterOwner) && Math.hypot(obj.x - pos.x, obj.y - pos.y) < range
  );
}

function isInFogOfWar(x, y) {
  const cellX = Math.floor(x / FOG_CELL_SIZE);
  const cellY = Math.floor(y / FOG_CELL_SIZE);
  return fogMap[cellY] && fogMap[cellY][cellX] === 0;
}

// Пулы объектов
const particlePool = [];
function getParticle() { return particlePool.pop() || {}; }
function releaseParticle(particle) {
  particle.x = 0; particle.y = 0; particle.vx = 0; particle.vy = 0;
  particle.life = 0; particle.maxLife = 0; particle.radius = 0;
  particle.length = 0; particle.thickness = 0; particle.angle = 0;
  particlePool.push(particle);
}

function createFragment() {
  return {
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    angularVelocity: 0,
    life: 0,
    maxLife: 0,
    points: [],
    color: "gray",
    rotationSpeed: 0
  };
}

function getFragment() {
  return fragmentPool.pop() || createFragment();
}

function releaseFragment(fragment) {
  fragment.x = 0; fragment.y = 0; fragment.vx = 0; fragment.vy = 0;
  fragment.angle = 0; fragment.angularVelocity = 0;
  fragment.life = 0; fragment.maxLife = 0; fragment.points = [];
  fragmentPool.push(fragment);
}

function getBulletFromPool(type, shooter, enemy, bulletConfig) {
  const pool = bulletPools[type];
  let bullet;
  if (pool.length > 0) {
    bullet = pool.pop();
    // 🔥 ПОЛНЫЙ СБРОС ВСЕХ ПОЛЕЙ ПУЛИ
    bullet.x = shooter.x;
    bullet.y = shooter.y;
    bullet.angle = Math.atan2(enemy.y - shooter.y, enemy.x - shooter.x);
    bullet.speed = bulletConfig.speed;
    bullet.shooter = shooter;
    bullet.target = enemy;
    bullet.alive = true;
    bullet.lifetime = bulletConfig.lifetime;
    bullet.damage = bulletConfig.damage;
    bullet.isMissile = false;
    bullet.isArtillery = false;
    bullet.isMelee = false;
    bullet.splashRadius = 0;
    bullet.splashDamage = 0;
    bullet.color = null; // Сбрасываем цвет — он установится в fireBullet
  } else {
    bullet = new Bullet(
      shooter.x, shooter.y,
      Math.atan2(enemy.y - shooter.y, enemy.x - shooter.x),
      bulletConfig.speed, shooter, enemy
    );
    bullet.lifetime = bulletConfig.lifetime;
    bullet.damage = bulletConfig.damage;
    bullet.isMissile = false;
    bullet.isArtillery = false;
    bullet.isMelee = false;
    bullet.splashRadius = 0;
    bullet.splashDamage = 0;
    bullet.color = null;
  }
  // Явно ставим флаг типа пули
  bullet.isMissile = (type === "missile");
  return bullet;
}

function releaseBulletToPool(bullet) {
  // 🔥 ПОЛНЫЙ СБРОС перед возвратом в пул
  bullet.alive = false;
  bullet.target = null;
  bullet.shooter = null;
  bullet.isMissile = false;
  bullet.isArtillery = false;
  bullet.isMelee = false;
  bullet.splashRadius = 0;
  bullet.splashDamage = 0;
  bullet.color = null;
  bullet.damage = 0;
  bullet.lifetime = 0;
  bullet.speed = 0;
  
  if (bullet.isMissile) bulletPools.missile.push(bullet);
  else bulletPools.regular.push(bullet);
}

class Quadtree {
  constructor(bounds, capacity = 4) {
    this.bounds = bounds; this.capacity = capacity; this.objects = []; this.divided = false;
  }
  insert(object) {
    if (!this.contains(this.bounds, object)) return false;
    if (this.objects.length < this.capacity) { this.objects.push(object); return true; }
    if (!this.divided) this.subdivide();
    return (this.northwest.insert(object) || this.northeast.insert(object) || this.southwest.insert(object) || this.southeast.insert(object));
  }
  subdivide() {
    const { x, y, width, height } = this.bounds;
    const halfW = width / 2, halfH = height / 2;
    this.northwest = new Quadtree({ x, y, width: halfW, height: halfH }, this.capacity);
    this.northeast = new Quadtree({ x: x + halfW, y, width: halfW, height: halfH }, this.capacity);
    this.southwest = new Quadtree({ x, y: y + halfH, width: halfW, height: halfH }, this.capacity);
    this.southeast = new Quadtree({ x: x + halfW, y: y + halfH, width: halfW, height: halfH }, this.capacity);
    this.divided = true;
  }
  query(range, found = []) {
    if (!this.intersects(this.bounds, range)) return found;
    for (const obj of this.objects) { if (this.contains(range, obj)) found.push(obj); }
    if (this.divided) {
      this.northwest.query(range, found); this.northeast.query(range, found);
      this.southwest.query(range, found); this.southeast.query(range, found);
    }
    return found;
  }
  contains(rect, object) {
    return (object.x >= rect.x && object.x <= rect.x + rect.width && object.y >= rect.y && object.y <= rect.y + rect.height);
  }
  intersects(rect1, rect2) {
    return !(rect1.x > rect2.x + rect2.width || rect1.x + rect1.width < rect2.x || rect1.y > rect2.y + rect2.height || rect1.y + rect1.height < rect2.y);
  }
  clear() {
    this.objects = [];
    if (this.divided) { this.northwest.clear(); this.northeast.clear(); this.southwest.clear(); this.southeast.clear(); this.divided = false; }
  }
}

let quadtreeCache = null, quadtreeCacheTime = 0;
const quadtreeCacheInterval = 100;
function getCachedObjectsInRange(range) {
  const now = performance.now();
  if (!quadtreeCache || (now - quadtreeCacheTime) > quadtreeCacheInterval) {
    quadtreeCache = quadtree ? quadtree.query(range) : [];
    quadtreeCacheTime = now;
  }
  return quadtreeCache;
}

function updateQuadtree() {
  if (quadtree) {
    quadtree.clear();
    [].concat(gameState.buildings, gameState.units, gameState.resources).forEach(obj => quadtree.insert(obj));
  }
}

function drawCircularHP(x, y, radius, health, maxHealth) {
  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + 2 * Math.PI * (health / maxHealth);
  ctx.beginPath(); ctx.arc(x, y, radius, 0, 2 * Math.PI); ctx.lineWidth = 3; ctx.strokeStyle = "red"; ctx.stroke();
  ctx.beginPath(); ctx.arc(x, y, radius, startAngle, endAngle); ctx.strokeStyle = "green"; ctx.stroke();
}

// ============================================================
// Глобальная функция изменения размера (добавить в конец utils.js)
// ============================================================
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const worldMultiplier = isMobile ? 4.5 : 3;
  worldWidth = canvas.width * worldMultiplier;
  worldHeight = canvas.height * worldMultiplier;

  if (typeof starField !== 'undefined' && starField.init) {
    starField.init();
  }
  
  if (typeof initFogOfWar === "function") {
    initFogOfWar();
  }

  if (typeof playerBase !== 'undefined' && playerBase) {
    camera.offsetX = canvas.width / 2 - playerBase.x * camera.scale;
    camera.offsetY = canvas.height / 2 - playerBase.y * camera.scale;
  } else {
    camera.offsetX = canvas.width / 2 - (worldWidth / 2) * camera.scale;
    camera.offsetY = canvas.height / 2 - (worldHeight / 2) * camera.scale;
  }

  const margin = 0.2 * worldWidth;
  if (typeof Quadtree !== 'undefined') {
    quadtree = new Quadtree({ 
      x: -margin, y: -margin, 
      width: worldWidth + 2 * margin, 
      height: worldHeight + 2 * margin 
    });
  }
}

// Привязываем функцию resizeCanvas к событию изменения размера окна
window.addEventListener("resize", resizeCanvas);