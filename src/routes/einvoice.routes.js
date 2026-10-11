import express from 'express';
import { authenticate } from '../middleware/auth.middleware.js';
import { db } from '../db/database.js';
import { v4 as uuidv4 } from 'uuid';

const router = express.Router();

/**
 * POST /api/einvoice/submit
 * Submit invoice to tax authority (Seqino PDP)
 */
router.post('/submit', authenticate, async (req, res) => {
  try {
    const { invoice_id, customer_siret } = req.body;

    if (!invoice_id) {
      return res.status(400).json({ error: 'invoice_id required' });
    }

    // Find or create invoice
    let invoice = db.invoices?.find(inv => inv.id === invoice_id);
    if (!invoice) {
      // Create demo invoice
      invoice = {
        id: invoice_id,
        merchant_id: req.user.id,
        invoice_number: `INV-${Date.now()}`,
        amount: 100.00,
        currency: 'EUR',
        customer_siret,
        status: 'draft',
        created_at: new Date()
      };
      if (!db.invoices) db.invoices = [];
      db.invoices.push(invoice);
    }

    // Verify ownership
    if (invoice.merchant_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Validate B2B requirement
    if (!customer_siret || customer_siret.length !== 14) {
      return res.status(400).json({ 
        error: 'Valid customer SIRET required for e-invoicing (14 digits)' 
      });
    }

    // BUG G: No duplicate submission check
    // Should prevent submitting the same invoice twice
    // Missing validation below:
    
    if (invoice.einvoice_status === 'submitted' || invoice.einvoice_status === 'accepted') {
      return res.status(409).json({ 
        error: 'Invoice already submitted to tax authority' 
      });
    }

    // Simulate tax authority submission
    const submission_id = `SUB-${uuidv4()}`;
    invoice.einvoice_status = 'submitted';
    invoice.einvoice_submission_id = submission_id;
    invoice.submitted_at = new Date();

    // In real system, this would call external API
    // await seqinoClient.submitInvoice(invoice);

    res.status(200).json({
      success: true,
      message: 'Invoice submitted to tax authority',
      data: {
        invoice_id,
        submission_id,
        status: 'submitted',
        submitted_at: invoice.submitted_at
      }
    });
  } catch (error) {
    console.error('E-invoice submission error:', error);
    res.status(500).json({ error: 'E-invoice submission failed' });
  }
});

/**
 * GET /api/einvoice/status/:invoice_id
 * Check e-invoice submission status
 */
router.get('/status/:invoice_id', authenticate, (req, res) => {
  try {
    const { invoice_id } = req.params;

    const invoice = db.invoices?.find(inv => inv.id === invoice_id);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    // Verify ownership
    if (invoice.merchant_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json({
      success: true,
      data: {
        invoice_id: invoice.id,
        invoice_number: invoice.invoice_number,
        einvoice_status: invoice.einvoice_status || 'not_submitted',
        submission_id: invoice.einvoice_submission_id,
        submitted_at: invoice.submitted_at,
        tax_authority_id: invoice.tax_authority_id
      }
    });
  } catch (error) {
    console.error('E-invoice status error:', error);
    res.status(500).json({ error: 'Failed to fetch e-invoice status' });
  }
});

export default router;
