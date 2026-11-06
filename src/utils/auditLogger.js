const { pool } = require('../config/db');

async function logAudit({ req, action, entityType, entityId, details }) {
  try {
    const actorId = req?.user?.id || null;
    const actorName = req?.user?.name || 'System';
    const actorRole = req?.user?.role || 'system';
    const ip = req?.headers['x-forwarded-for'] || req?.socket?.remoteAddress || 'unknown';

    await pool.query(
      `INSERT INTO audit_logs (actor_id, actor_name, actor_role, action, entity_type, entity_id, details, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [actorId, actorName, actorRole, action, entityType, String(entityId || ''), JSON.stringify(details || {}), ip]
    );
  } catch (err) {
    console.error('Audit Log failure:', err.message);
  }
}

module.exports = { logAudit };
