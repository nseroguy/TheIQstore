const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../../config/db');
const { requireAuth, requireRole } = require('../../middleware/auth.middleware');

const generatePin = () => Math.floor(1000 + Math.random() * 9000).toString();

// 1. PUBLIC: Track an order
router.get('/track/:trackingCode', async (req, res) => {
  try {
    const { trackingCode } = req.params;
    const query = `
      SELECT d.tracking_code, d.delivery_status, d.recipient_name, d.recipient_phone,
             d.shipping_address, d.notes, d.estimated_arrival, d.delivered_at,
             d.delivery_pin, d.proof_of_delivery, o.total_amount, o.payment_method, o.payment_status,
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

// 2. CUSTOMER: Place Order with Payment Method Selection
router.post('/order', requireAuth, requireRole(['customer', 'admin']), async (req, res) => {
  const client = await pool.connect();
  try {
    const { recipient_name, recipient_phone, shipping_address, notes, total_amount, payment_method, payment_phone } = req.body;
    await client.query('BEGIN');

    const paymentMethod = payment_method === 'mobile_money' ? 'mobile_money' : 'cash';
    const paymentStatus = paymentMethod === 'cash' ? 'pending_cash_on_delivery' : 'mobile_money_confirmed';

    const orderRes = await client.query(
      `INSERT INTO orders (customer_id, total_amount, payment_status, payment_method, payment_phone)
       VALUES ($1, $2, $3, $4, $5) RETURNING id;`,
      [req.user.id, total_amount || 25.00, paymentStatus, paymentMethod, payment_phone || null]
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
      payment_method: paymentMethod,
      delivery: deliveryRes.rows[0] 
    });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// 3. DISPATCH DESK & ADMIN: Kitchen Queue
router.get('/dispatch/queue', requireAuth, requireRole(['staff', 'admin']), async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT d.*, o.total_amount, o.payment_method, o.payment_status, u.name as driver_name
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
              d.estimated_arrival, o.total_amount, o.payment_method, o.payment_status
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
      return res.status(400).json({ error: 'Invalid status transition' });
    }
    if (!pin || pin.toString().trim() === '') {
      return res.status(400).json({ error: `Verification PIN required to confirm ${status === 'in_transit' ? 'pickup' : 'delivery'}` });
    }

    const checkQuery = `
      SELECT pickup_pin, delivery_pin, delivery_status 
      FROM deliveries 
      WHERE UPPER(tracking_code) = UPPER($1) AND driver_id = $2::uuid;
    `;
    const checkRes = await pool.query(checkQuery, [tracking_code, req.user.id]);
    if (checkRes.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found or not assigned to you' });
    }

    const currentOrder = checkRes.rows[0];
    const cleanPin = pin.toString().trim();

    if (status === 'in_transit') {
      if (currentOrder.pickup_pin && currentOrder.pickup_pin !== cleanPin) {
        return res.status(400).json({ error: 'Invalid Store Pickup PIN. Ask bakery kitchen staff.' });
      }
    } else if (status === 'delivered') {
      if (currentOrder.delivery_pin && currentOrder.delivery_pin !== cleanPin) {
        return res.status(400).json({ error: 'Invalid Customer Delivery PIN. Ask customer at drop-off.' });
      }
    }

    const updateQuery = `
      UPDATE deliveries 
      SET delivery_status = $1::VARCHAR,
          proof_of_delivery = COALESCE($2::TEXT, proof_of_delivery),
          delivered_at = CASE WHEN $1::VARCHAR = 'delivered' THEN NOW() ELSE delivered_at END,
          updated_at = NOW()
      WHERE UPPER(tracking_code) = UPPER($3) AND driver_id = $4::UUID
      RETURNING *;
    `;
    const result = await pool.query(updateQuery, [
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
