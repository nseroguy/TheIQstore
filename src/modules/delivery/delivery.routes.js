const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../../config/db');
const { requireAuth, requireRole } = require('../../middleware/auth.middleware');

// Helper to generate a random 4-digit PIN
const generatePin = () => Math.floor(1000 + Math.random() * 9000).toString();

// 1. PUBLIC / CUSTOMER: Track an order (Includes customer's secret delivery_pin)
router.get('/track/:trackingCode', async (req, res) => {
  try {
    const { trackingCode } = req.params;
    const query = `
      SELECT d.tracking_code, d.delivery_status, d.recipient_name, d.recipient_phone,
             d.shipping_address, d.notes, d.estimated_arrival, d.delivered_at,
             d.proof_of_delivery, d.delivery_pin, o.total_amount,
             u.name as driver_name, u.phone as driver_phone, u.vehicle_info
      FROM deliveries d
      LEFT JOIN orders o ON d.order_id = o.id
      LEFT JOIN users u ON d.driver_id = u.id
      WHERE UPPER(d.tracking_code) = UPPER($1);
    `;
    const result = await pool.query(query, [trackingCode]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tracking code not found' });
    }
    res.json({ success: true, tracking: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. CUSTOMER: Place Confectionery Order (Generates Pickup and Delivery PINs)
router.post('/order', requireAuth, requireRole(['customer', 'admin']), async (req, res) => {
  const client = await pool.connect();
  try {
    const { recipient_name, recipient_phone, shipping_address, notes, total_amount } = req.body;
    await client.query('BEGIN');

    const orderRes = await client.query(
      `INSERT INTO orders (customer_id, total_amount, payment_status) VALUES ($1, $2, 'paid') RETURNING id;`,
      [req.user.id, total_amount || 25.00]
    );
    const orderId = orderRes.rows[0].id;
    const trackingCode = 'IQ-' + crypto.randomBytes(3).toString('hex').toUpperCase();

    const pickupPin = generatePin();
    const deliveryPin = generatePin();

    const deliveryRes = await client.query(
      `INSERT INTO deliveries 
        (order_id, recipient_name, recipient_phone, shipping_address, notes, tracking_code, pickup_pin, delivery_pin, delivery_status, estimated_arrival)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'unassigned', NOW() + INTERVAL '45 minutes')
       RETURNING *;`,
      [orderId, recipient_name, recipient_phone, shipping_address, notes, trackingCode, pickupPin, deliveryPin]
    );

    await client.query('COMMIT');
    res.status(201).json({ 
      success: true, 
      tracking_code: trackingCode, 
      delivery_pin: deliveryPin,
      delivery: deliveryRes.rows[0] 
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 3. DISPATCH DESK & ADMIN: Kitchen Queue (Exposes pickup_pin for kitchen staff hand-off)
router.get('/dispatch/queue', requireAuth, requireRole(['staff', 'admin']), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, o.total_amount, u.name as driver_name
      FROM deliveries d
      JOIN orders o ON d.order_id = o.id
      LEFT JOIN users u ON d.driver_id = u.id
      ORDER BY d.created_at DESC;
    `);
    res.json({ success: true, deliveries: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. DISPATCH DESK & ADMIN: Assign Rider
router.patch('/:trackingCode/assign-rider', requireAuth, requireRole(['staff', 'admin']), async (req, res) => {
  try {
    const { trackingCode } = req.params;
    const { driver_id } = req.body;

    const result = await pool.query(
      `UPDATE deliveries 
       SET driver_id = $1::uuid, delivery_status = 'assigned', updated_at = NOW()
       WHERE UPPER(tracking_code) = UPPER($2)
       RETURNING *;`,
      [driver_id, trackingCode]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Order not found' });
    res.json({ success: true, delivery: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. RIDER: My Tasks
router.get('/rider/my-tasks', requireAuth, requireRole(['driver']), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.id, d.order_id, d.driver_id, d.delivery_status, d.recipient_name,
              d.recipient_phone, d.shipping_address, d.tracking_code, d.notes,
              d.estimated_arrival, d.delivered_at, d.created_at, o.total_amount 
       FROM deliveries d
       JOIN orders o ON d.order_id = o.id
       WHERE d.driver_id = $1::uuid AND d.delivery_status != 'delivered'
       ORDER BY d.created_at ASC;`,
      [req.user.id]
    );
    res.json({ success: true, tasks: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. RIDER: Update Status with PIN Verification
router.patch('/rider/update-status', requireAuth, requireRole(['driver']), async (req, res) => {
  try {
    const { tracking_code, status, pin, proof_of_delivery } = req.body;

    if (!['in_transit', 'delivered'].includes(status)) {
      return res.status(400).json({ error: "Invalid status transition" });
    }

    if (!pin) {
      return res.status(400).json({ error: `Verification PIN is required to proceed.` });
    }

    // Retrieve order to verify corresponding PIN
    const orderCheck = await pool.query(
      `SELECT pickup_pin, delivery_pin, delivery_status, driver_id 
       FROM deliveries 
       WHERE UPPER(tracking_code) = UPPER($1) AND driver_id = $2::uuid;`,
      [tracking_code, req.user.id]
    );

    if (orderCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found or not assigned to you.' });
    }

    const currentOrder = orderCheck.rows[0];

    // Check Pickup PIN from bakery kitchen
    if (status === 'in_transit') {
      if (currentOrder.pickup_pin && currentOrder.pickup_pin.trim() !== pin.toString().trim()) {
        return res.status(403).json({ error: 'Invalid Store Pickup PIN. Please verify with bakery dispatch.' });
      }
    }

    // Check Delivery PIN from customer
    if (status === 'delivered') {
      if (currentOrder.delivery_pin && currentOrder.delivery_pin.trim() !== pin.toString().trim()) {
        return res.status(403).json({ error: 'Invalid Customer Delivery PIN. Please ask recipient for their 4-digit code.' });
      }
    }

    const query = `
      UPDATE deliveries 
      SET delivery_status = $1::VARCHAR,
          proof_of_delivery = COALESCE($2::TEXT, proof_of_delivery),
          delivered_at = CASE WHEN $1::VARCHAR = 'delivered' THEN NOW() ELSE delivered_at END,
          updated_at = NOW()
      WHERE UPPER(tracking_code) = UPPER($3) AND driver_id = $4::uuid
      RETURNING *;
    `;
    const result = await pool.query(query, [
      status, 
      proof_of_delivery || null, 
      tracking_code, 
      req.user.id
    ]);

    res.json({ success: true, delivery: result.rows[0] });
  } catch (err) {
    console.error('Rider status update error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
