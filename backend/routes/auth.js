import express from 'express';
import { body, validationResult } from 'express-validator';
import crypto from 'crypto';
import User from '../models/User.js';
import { generateToken, generateResetToken, generateEmailVerificationToken } from '../utils/generateToken.js';
import { sendPasswordResetEmail, sendEmailVerification } from '../utils/sendEmail.js';
import { protect } from '../middleware/auth.js';

const router = express.Router();

const passwordPolicy = /^(?=.*[0-9])(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>\/?]).{8,}$/;
const passwordPolicyMsg = 'Password must be at least 8 characters and include at least one number and one special character';

// @desc    Register user
// @route   POST /api/auth/register
// @access  Public
router.post('/register', [
  body('name').trim().isLength({ min: 2, max: 100 }).withMessage('Name must be between 2 and 100 characters'),
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email'),
  body('employeeId').matches(/^AUTO-\d{4}$/).withMessage('Employee ID must be in format AUTO-0001'),
  body('password').matches(passwordPolicy).withMessage(passwordPolicyMsg),
  body('phone').matches(/^03\d{9}$/).withMessage('Phone must be 11 digits, start with 03'),
  body('cnic').matches(/^\d{5}-\d{7}-\d{1}$/).withMessage('CNIC must be in format XXXXX-XXXXXXX-X'),
  body('city').isIn(['Multan', 'Islamabad', 'Kamra', 'Karachi']).withMessage('Please select a valid city')
], async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: errors.array()[0].msg
      });
    }

    const { name, email, employeeId, password, phone, cnic, city } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email }, { employeeId }, { cnic }]
    });

    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: 'User with this email, employee ID, or CNIC already exists'
      });
    }

    // Create user
    const user = await User.create({
      name,
      email,
      employeeId,
      password,
      phone,
      cnic,
      city
    });

    // Generate email verification token
    const verificationToken = generateEmailVerificationToken();
    user.emailVerificationToken = verificationToken;
    user.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    await user.save();

    // Send verification email
    try {
      await sendEmailVerification(email, verificationToken);
    } catch (emailError) {
      console.error('Email verification error:', emailError);
      // Don't fail registration if email fails
    }

    // Generate JWT token
    const token = generateToken(user._id);

    res.status(201).json({
      success: true,
      message: 'User registered successfully. Please check your email for verification.',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        employeeId: user.employeeId,
        role: user.role,
        isEmailVerified: user.isEmailVerified
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error during registration'
    });
  }
});

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
router.post('/login', [
  body('employeeId').notEmpty().withMessage('Employee ID is required'),
  body('password').notEmpty().withMessage('Password is required')
], async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: errors.array()[0].msg
      });
    }

    const { employeeId, password } = req.body;

    // Find user by employee ID
    const user = await User.findOne({ employeeId }).select('+password');

    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Check if user is active
    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        error: 'Account is deactivated'
      });
    }

    // Check password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({
        success: false,
        error: 'Invalid credentials'
      });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate JWT token
    const token = generateToken(user._id);

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        employeeId: user.employeeId,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        department: user.department,
        designation: user.designation
      }
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error during login'
    });
  }
});

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);
    
    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        employeeId: user.employeeId,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        department: user.department,
        designation: user.designation,
        lastLogin: user.lastLogin
      }
    });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @desc    Forgot password
// @route   POST /api/auth/forgot-password
// @access  Public
router.post('/forgot-password', [
  body('email').isEmail().normalizeEmail().withMessage('Please provide a valid email')
], async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: errors.array()[0].msg
      });
    }

    const { email } = req.body;

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'User not found'
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(20).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = Date.now() + 60 * 60 * 1000; // 1 hour
    await user.save();

    // Send reset email
    try {
      await sendPasswordResetEmail(email, resetToken);
      res.json({
        success: true,
        message: 'Password reset email sent'
      });
    } catch (emailError) {
      console.error('Password reset email error:', emailError);
      res.status(500).json({
        success: false,
        error: 'Error sending password reset email'
      });
    }
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @desc    Reset password
// @route   PUT /api/auth/reset-password
// @access  Public
router.put('/reset-password', [
  body('token').notEmpty().withMessage('Reset token is required'),
  body('password').matches(passwordPolicy).withMessage(passwordPolicyMsg)
], async (req, res) => {
  try {
    // Check for validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        error: errors.array()[0].msg
      });
    }

    const { token, password } = req.body;

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired reset token'
      });
    }

    // Set new password
    user.password = password;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();

    res.json({
      success: true,
      message: 'Password reset successful'
    });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @desc    Verify email
// @route   GET /api/auth/verify-email
// @access  Public
router.get('/verify-email', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Verification token is required'
      });
    }

    const user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or expired verification token'
      });
    }

    // Mark email as verified
    user.isEmailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    res.json({
      success: true,
      message: 'Email verified successfully'
    });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

// @desc    Resend verification email
// @route   POST /api/auth/resend-verification
// @access  Private
router.post('/resend-verification', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (user.isEmailVerified) {
      return res.status(400).json({
        success: false,
        error: 'Email is already verified'
      });
    }

    // Generate new verification token
    const verificationToken = generateEmailVerificationToken();
    user.emailVerificationToken = verificationToken;
    user.emailVerificationExpires = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    await user.save();

    // Send verification email
    try {
      await sendEmailVerification(user.email, verificationToken);
      res.json({
        success: true,
        message: 'Verification email sent'
      });
    } catch (emailError) {
      console.error('Email verification error:', emailError);
      res.status(500).json({
        success: false,
        error: 'Error sending verification email'
      });
    }
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error'
    });
  }
});

export default router;
