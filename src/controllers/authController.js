'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const User = require('../models/User');

function formatValidationErrors(errors) {
  return errors.array().map(e => e.msg).join(', ');
}

/**
 * POST /api/auth/register
 * Body: { name, email, password, role, collegeId, preferredLanguage }
 */
async function register(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: formatValidationErrors(errors) });
    }

    const { name, email, password, role, collegeId, preferredLanguage } = req.body;

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) return res.status(409).json({ error: 'Email already registered' });

    const passwordHash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_SALT_ROUNDS) || 10);

    const user = await User.create({
      name,
      email: email.toLowerCase().trim(),
      passwordHash,
      role,
      collegeId,
      preferredLanguage,
    });

    res.status(201).json({
      userId: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
async function login(req, res, next) {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: formatValidationErrors(errors) });
    }

    const { email, password } = req.body;

    let user = await User.findOne({ email: email.toLowerCase().trim() });
    
    if (!user) {
      // Auto-register
      const { name = 'New User', role = 'student', collegeId, preferredLanguage } = req.body;
      const passwordHash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_SALT_ROUNDS) || 10);
      user = await User.create({
        name,
        email: email.toLowerCase().trim(),
        passwordHash,
        role,
        collegeId,
        preferredLanguage,
      });
    } else {
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    );

    res.status(200).json({
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        preferredLanguage: user.preferredLanguage,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/auth/me
 * Protected by requireAuth
 */
async function getCurrentUser(req, res, next) {
  try {
    const user = await User.findById(req.user.id).select('-passwordHash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    next(err);
  }
}

module.exports = { register, login, getCurrentUser };
