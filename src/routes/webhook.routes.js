import express from 'express';
import crypto from 'crypto';
import { getPaymentById, db } from '../db/database.js';

const router = express.Router();

// Webhook secret for HMAC verification
const WEBHOOK_SECRET = 'test-webhook-secret-key';

// FIX Bug E: remember which webhook events were already handled (idempotency)
const processedEvents = new Set();

/**
 * POST /api/webhooks/payment-status
 * 
 * Simulates external payment provider webhooks (like Powens)
 * Tests webhook signature verification and idempotency
 */
router.post('/payment-status', (req, res) => {
  try {
    const signature = req.headers['x-webhook-signature'];
    const { payment_id, status, event_id } = req.body;

    // FIX Bug D: verify the HMAC-SHA256 signature before trusting the webhook
    const expectedSignature = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(JSON.stringify(req.body))
      .digest('hex');

    const signatureBuffer = Buffer.from(String(signature || ''));
    const expectedBuffer = Buffer.from(expectedSignature);

    // Constant-time comparison avoids timing attacks; lengths must match first
    if (
      signatureBuffer.length !== expectedBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
    ) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    if (!payment_id || !status) {
      return res.status(400).json({ error: 'payment_id and status required' });
    }

    // FIX Bug E: event_id is needed to detect duplicate deliveries
    if (!event_id) {
      return res.status(400).json({ error: 'event_id required' });
    }

    // FIX Bug E: if this event was already processed, acknowledge without changing anything
    if (processedEvents.has(event_id)) {
      return res.status(200).json({ message: 'Already processed' });
    }

    const payment = getPaymentById(payment_id);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // Update payment status
    payment.status = status;
    payment.webhook_received_at = new Date();

    // FIX Bug E: mark as processed only after a successful update
    processedEvents.add(event_id);

    res.status(200).json({
      success: true,
      message: 'Webhook processed',
      payment_id,
      new_status: status
    });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

/**
 * POST /api/webhooks/e-invoice
 * 
 * Simulates e-invoice submission webhook from tax authority
 */
router.post('/e-invoice', (req, res) => {
  try {
    const { invoice_id, status, submission_id, tax_authority_id } = req.body;

    if (!invoice_id || !status) {
      return res.status(400).json({ error: 'invoice_id and status required' });
    }

    // Find invoice in database
    const invoice = db.invoices?.find(inv => inv.id === invoice_id);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Update invoice status
    invoice.einvoice_status = status;
    invoice.einvoice_submission_id = submission_id;
    invoice.tax_authority_id = tax_authority_id;
    invoice.submitted_at = new Date();

    res.status(200).json({
      success: true,
      message: 'E-invoice webhook processed',
      invoice_id,
      status
    });
  } catch (error) {
    console.error('E-invoice webhook error:', error);
    res.status(500).json({ error: 'E-invoice webhook failed' });
  }
});

export default router;