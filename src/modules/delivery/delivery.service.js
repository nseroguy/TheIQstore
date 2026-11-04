const db = require('../../config/db');
const crypto = require('crypto');

class DeliveryService {
  // Generate random public tracking code
  static generateTrackingCode() {
    return 'IQ-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  }

  // Create delivery record automatically when order is placed
  static async createDelivery({ orderId, recipientName, recipientPhone, shippingAddress, notes }) {
    const trackingCode = this.generateTrackingCode();
    const query = `
      INSERT INTO deliveries 
        (order_id, recipient_name, recipient_phone, shipping_address, tracking_code, delivery_status, notes)
      VALUES ($1, $2, $3, $4, $5, 'unassigned', $6)
      RETURNING *;
    `;
    const res = await db.query(query, [orderId, recipientName, recipientPhone, shippingAddress, trackingCode, notes]);
    return res.rows[0];
  }

  // Assign driver to shipment
  static async assignDriver(deliveryId, driverId) {
    const query = `
      UPDATE deliveries 
      SET driver_id = $1, delivery_status = 'assigned', updated_at = NOW()
      WHERE id = $2
      RETURNING *;
    `;
    const res = await db.query(query, [driverId, deliveryId]);
    return res.rows[0];
  }

  // Status updates: 'picked_up' -> 'in_transit' -> 'delivered'
  static async updateStatus(deliveryId, status, proofOfDelivery = null) {
    const query = `
      UPDATE deliveries 
      SET delivery_status = $1, 
          proof_of_delivery = COALESCE($2, proof_of_delivery),
          delivered_at = CASE WHEN $1 = 'delivered' THEN NOW() ELSE delivered_at END,
          updated_at = NOW()
      WHERE id = $3
      RETURNING *;
    `;
    const res = await db.query(query, [status, proofOfDelivery, deliveryId]);
    return res.rows[0];
  }

  // Public order tracking (no login required)
  static async getTrackingInfo(trackingCode) {
    const query = `
      SELECT d.tracking_code, d.delivery_status, d.shipping_address, d.estimated_arrival, 
             d.delivered_at, d.updated_at, o.id as order_id, o.total_amount
      FROM deliveries d
      JOIN orders o ON d.order_id = o.id
      WHERE d.tracking_code = $1;
    `;
    const res = await db.query(query, [trackingCode]);
    return res.rows[0] || null;
  }
}

module.exports = DeliveryService;