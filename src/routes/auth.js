'use strict';

const router = require('express').Router();
const { body } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { register, login, getCurrentUser } = require('../controllers/authController');

// POST /api/auth/register
router.post('/register', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('role').isIn(['professor', 'student', 'admin']).withMessage('Role must be professor, student, or admin')
], register);

// POST /api/auth/login
router.post('/login', [
  body('email').isEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
  body('role').optional().isIn(['professor', 'student', 'admin']).withMessage('Role must be professor, student, or admin')
], login);

// GET /api/auth/me
router.get('/me', requireAuth, getCurrentUser);

module.exports = router;
