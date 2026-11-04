const express = require('express');
const router = express.Router();
const DeliveryService = require('./delivery.service');
const { requireAuth, requireRole } = require('../../middleware/auth.middleware');

// Public tracking lookup
router.get('/track/:trackingCode', async (req, res) => {
  try {
    const tracking = await DeliveryService.getTrackingInfo(req.params.trackingCode);
    if (!tracking) return res.status(404).json({ error: 'Tracking code not found' });
    res.json({ success: true, tracking });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: Assign delivery to driver
router.patch('/:id/assign', requireAuth, requireRole(['admin']), async (req, res) => {
  try {
    const updated = await DeliveryService.assignDriver(req.params.id, req.body.driverId);
    res.json({ success: true, delivery: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Driver: Update status (picked_up, in_transit, delivered)
router.patch('/:id/status', requireAuth, requireRole(['driver', 'admin']), async (req, res) => {
  try {
    const { status, proofOfDelivery } = req.body;
    const updated = await DeliveryService.updateStatus(req.params.id, status, proofOfDelivery);
    res.json({ success: true, delivery: updated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;