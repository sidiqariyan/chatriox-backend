// routes/templatess.js
const express = require('express');
const router = express.Router();
const Template = require('../models/Template');
const User = require('../models/User');
const auth = require('../middleware/auth');
const { body, validationResult } = require('express-validator');

// Validation middleware
const validateTemplate = [
  body('name').notEmpty().trim().isLength({ max: 100 }).withMessage('Template name is required and must be less than 100 characters'),
  body('subject').notEmpty().trim().isLength({ max: 200 }).withMessage('Subject is required and must be less than 200 characters'),
  body('htmlContent').notEmpty().withMessage('HTML content is required'),
  body('components').isArray().withMessage('Components must be an array'),
  body('preheader').optional().isLength({ max: 150 }).withMessage('Preheader must be less than 150 characters')
];

// GET /api/templates - Get all templates for user
router.get('/', auth, async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 10, 
      category, 
      search, 
      sortBy = 'createdAt', 
      sortOrder = 'desc',
      isPublic 
    } = req.query;

    // Build query
    let query = { userId: req.user.id };
    
    if (category && category !== 'all') {
      query.category = category;
    }
    
    if (search) {
      query.$text = { $search: search };
    }
    
    if (isPublic !== undefined) {
      query.isPublic = isPublic === 'true';
    }

    // Sort options
    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const templates = await Template.find(query)
      .sort(sortOptions)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .populate('userId', 'name email')
      .exec();

    const total = await Template.countDocuments(query);

    res.json({
      success: true,
      data: {
        templates,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: templates.length,
          totalRecords: total
        }
      }
    });
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching templates',
      error: error.message
    });
  }
});

// GET /api/templates/public - Get public templates
router.get('/public', async (req, res) => {
  try {
    const { 
      page = 1, 
      limit = 12, 
      category, 
      search, 
      sortBy = 'rating.average', 
      sortOrder = 'desc' 
    } = req.query;

    let query = { isPublic: true, status: 'published' };
    
    if (category && category !== 'all') {
      query.category = category;
    }
    
    if (search) {
      query.$text = { $search: search };
    }

    const sortOptions = {};
    sortOptions[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const templates = await Template.find(query)
      .sort(sortOptions)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .populate('userId', 'name')
      .select('-htmlContent') // Don't send full HTML content for list view
      .exec();

    const total = await Template.countDocuments(query);

    res.json({
      success: true,
      data: {
        templates,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: templates.length,
          totalRecords: total
        }
      }
    });
  } catch (error) {
    console.error('Error fetching public templates:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching public templates',
      error: error.message
    });
  }
});

// GET /api/templates/:id - Get single template
router.get('/:id', auth, async (req, res) => {
  try {
    const template = await Template.findById(req.params.id)
      .populate('userId', 'name email');

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    // Check if user owns template or it's public
    if (template.userId.toString() !== req.user.id && !template.isPublic) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    // Increment view count
    await Template.findByIdAndUpdate(req.params.id, {
      $inc: { 'usage.views': 1 }
    });

    res.json({
      success: true,
      data: template
    });
  } catch (error) {
    console.error('Error fetching template:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching template',
      error: error.message
    });
  }
});

// POST /api/templates - Create new template
router.post('/', auth, validateTemplate, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const templateData = {
      ...req.body,
      userId: req.user.id
    };

    const template = new Template(templateData);
    await template.save();

    // Populate user data
    await template.populate('userId', 'name email');

    res.status(201).json({
      success: true,
      message: 'Template created successfully',
      data: template
    });
  } catch (error) {
    console.error('Error creating template:', error);
    res.status(500).json({
      success: false,
      message: 'Error creating template',
      error: error.message
    });
  }
});

// PUT /api/templates/:id - Update template
router.put('/:id', auth, validateTemplate, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const template = await Template.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    // Check ownership
    if (template.userId.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const updatedTemplate = await Template.findByIdAndUpdate(
      req.params.id,
      { ...req.body, updatedAt: new Date() },
      { new: true }
    ).populate('userId', 'name email');

    res.json({
      success: true,
      message: 'Template updated successfully',
      data: updatedTemplate
    });
  } catch (error) {
    console.error('Error updating template:', error);
    res.status(500).json({
      success: false,
      message: 'Error updating template',
      error: error.message
    });
  }
});

// DELETE /api/templates/:id - Delete template
router.delete('/:id', auth, async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    // Check ownership
    if (template.userId.toString() !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    await Template.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Template deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting template:', error);
    res.status(500).json({
      success: false,
      message: 'Error deleting template',
      error: error.message
    });
  }
});

// POST /api/templates/:id/duplicate - Duplicate template
router.post('/:id/duplicate', auth, async (req, res) => {
  try {
    const originalTemplate = await Template.findById(req.params.id);
    
    if (!originalTemplate) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    // Check if template is accessible
    if (originalTemplate.userId.toString() !== req.user.id && !originalTemplate.isPublic) {
      return res.status(403).json({
        success: false,
        message: 'Access denied'
      });
    }

    const duplicatedTemplate = new Template({
      name: `${originalTemplate.name} (Copy)`,
      subject: originalTemplate.subject,
      preheader: originalTemplate.preheader,
      htmlContent: originalTemplate.htmlContent,
      components: originalTemplate.components,
      settings: originalTemplate.settings,
      userId: req.user.id,
      category: originalTemplate.category,
      tags: originalTemplate.tags,
      isPublic: false,
      isAIGenerated: originalTemplate.isAIGenerated,
      aiPrompt: originalTemplate.aiPrompt
    });

    await duplicatedTemplate.save();
    await duplicatedTemplate.populate('userId', 'name email');

    res.status(201).json({
      success: true,
      message: 'Template duplicated successfully',
      data: duplicatedTemplate
    });
  } catch (error) {
    console.error('Error duplicating template:', error);
    res.status(500).json({
      success: false,
      message: 'Error duplicating template',
      error: error.message
    });
  }
});

// POST /api/templates/:id/rate - Rate template
router.post('/:id/rate', auth, async (req, res) => {
  try {
    const { rating, comment } = req.body;

    if (!rating || rating < 1 || rating > 5) {
      return res.status(400).json({
        success: false,
        message: 'Rating must be between 1 and 5'
      });
    }

    const template = await Template.findById(req.params.id);
    
    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    // Check if user already rated this template
    const existingRating = template.rating.reviews.find(
      review => review.userId.toString() === req.user.id
    );

    if (existingRating) {
      // Update existing rating
      existingRating.rating = rating;
      existingRating.comment = comment;
    } else {
      // Add new rating
      template.rating.reviews.push({
        userId: req.user.id,
        rating,
        comment
      });
    }

    // Recalculate average rating
    const totalRatings = template.rating.reviews.length;
    const sumRatings = template.rating.reviews.reduce((sum, review) => sum + review.rating, 0);
    template.rating.average = sumRatings / totalRatings;
    template.rating.count = totalRatings;

    await template.save();

    res.json({
      success: true,
      message: 'Rating submitted successfully',
      data: {
        average: template.rating.average,
        count: template.rating.count
      }
    });
  } catch (error) {
    console.error('Error rating template:', error);
    res.status(500).json({
      success: false,
      message: 'Error rating template',
      error: error.message
    });
  }
});

// GET /api/templates/stats/dashboard - Get user template statistics
router.get('/stats/dashboard', auth, async (req, res) => {
  try {
    const userId = req.user.id;

    const stats = await Template.aggregate([
      { $match: { userId: mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: null,
          totalTemplates: { $sum: 1 },
          totalViews: { $sum: '$usage.views' },
          totalDownloads: { $sum: '$usage.downloads' },
          totalUses: { $sum: '$usage.uses' },
          aiGeneratedCount: {
            $sum: { $cond: ['$isAIGenerated', 1, 0] }
          },
          publicCount: {
            $sum: { $cond: ['$isPublic', 1, 0] }
          },
          averageRating: { $avg: '$rating.average' }
        }
      }
    ]);

    const categoryStats = await Template.aggregate([
      { $match: { userId: mongoose.Types.ObjectId(userId) } },
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 }
        }
      }
    ]);

    const recentTemplates = await Template.find({ userId })
      .sort({ createdAt: -1 })
      .limit(5)
      .select('name subject createdAt usage rating');

    res.json({
      success: true,
      data: {
        overview: stats[0] || {
          totalTemplates: 0,
          totalViews: 0,
          totalDownloads: 0,
          totalUses: 0,
          aiGeneratedCount: 0,
          publicCount: 0,
          averageRating: 0
        },
        categoryBreakdown: categoryStats,
        recentTemplates
      }
    });
  } catch (error) {
    console.error('Error fetching template stats:', error);
    res.status(500).json({
      success: false,
      message: 'Error fetching template statistics',
      error: error.message
    });
  }
});

module.exports = router;