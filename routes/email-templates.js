const express = require('express');
const Template = require('../models/EmailTemplate');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Get all public templates + user's private templates
router.get('/', auth, async (req, res) => {
  try {
    const { category, search, page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
    
    const query = {
      $or: [
        { isPublic: true, isActive: true },
        { createdBy: req.user.id, isActive: true }
      ]
    };

    if (category && category !== 'all') {
      query.category = category;
    }

    if (search) {
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { name: { $regex: search, $options: 'i' } },
          { subject: { $regex: search, $options: 'i' } },
          { tags: { $in: [new RegExp(search, 'i')] } }
        ]
      });
    }

    const sort = {};
    sort[sortBy] = sortOrder === 'desc' ? -1 : 1;

    const templates = await Template.find(query)
      .populate('createdBy', 'name email')
      .sort(sort)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Template.countDocuments(query);

    res.json({
      templates,
      pagination: {
        current: parseInt(page),
        pages: Math.ceil(total / limit),
        total
      }
    });
  } catch (error) {
    console.error('Get templates error:', error);
    res.status(500).json({ message: 'Error fetching templates', error: error.message });
  }
});

// Get user's templates only
router.get('/my-templates', auth, async (req, res) => {
  try {
    const { page = 1, limit = 20 } = req.query;
    
    const templates = await Template.find({ 
      createdBy: req.user.id, 
      isActive: true 
    })
      .sort({ updatedAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .lean();

    const total = await Template.countDocuments({ 
      createdBy: req.user.id, 
      isActive: true 
    });

    res.json({
      templates,
      pagination: {
        current: parseInt(page),
        pages: Math.ceil(total / limit),
        total
      }
    });
  } catch (error) {
    console.error('Get my templates error:', error);
    res.status(500).json({ message: 'Error fetching your templates', error: error.message });
  }
});

// Get single template
router.get('/:id', auth, async (req, res) => {
  try {
    const template = await Template.findOne({
      _id: req.params.id,
      $or: [
        { isPublic: true, isActive: true },
        { createdBy: req.user.id, isActive: true }
      ]
    }).populate('createdBy', 'name email');

    if (!template) {
      return res.status(404).json({ message: 'Template not found' });
    }

    res.json({ template });
  } catch (error) {
    console.error('Get template error:', error);
    res.status(500).json({ message: 'Error fetching template', error: error.message });
  }
});

// Create template
router.post('/', auth, async (req, res) => {
  try {
    const templateData = {
      ...req.body,
      createdBy: req.user.id
    };

    const template = new Template(templateData);
    await template.save();

    const populatedTemplate = await Template.findById(template._id)
      .populate('createdBy', 'name email');

    res.status(201).json({ 
      message: 'Template created successfully', 
      template: populatedTemplate 
    });
  } catch (error) {
    console.error('Create template error:', error);
    res.status(500).json({ message: 'Error creating template', error: error.message });
  }
});

// Update template
router.put('/:id', auth, async (req, res) => {
  try {
    const template = await Template.findOne({
      _id: req.params.id,
      createdBy: req.user.id,
      isActive: true
    });

    if (!template) {
      return res.status(404).json({ message: 'Template not found or access denied' });
    }

    const updateData = { ...req.body };
    
    // If rating is sent as an object { average: 0, count: 0 }, convert it
    if (updateData.rating && typeof updateData.rating === 'object') {
      if (updateData.rating.average !== undefined) {
        updateData.rating = updateData.rating.average;
      }
      if (updateData.rating.count !== undefined) {
        updateData.ratingCount = updateData.rating.count;
      }
      // Fallback if it's still an object
      if (typeof updateData.rating === 'object') {
        updateData.rating = 0;
      }
    }

    Object.assign(template, updateData);  // ← Now using updateData instead of req.body
    await template.save();

    const updatedTemplate = await Template.findById(template._id)
      .populate('createdBy', 'name email');

    res.json({ 
      message: 'Template updated successfully', 
      template: updatedTemplate 
    });
  } catch (error) {
    console.error('Update template error:', error);
    res.status(500).json({ message: 'Error updating template', error: error.message });
  }
});

// Delete template (soft delete)
router.delete('/:id', auth, async (req, res) => {
  try {
    const template = await Template.findOne({
      _id: req.params.id,
      createdBy: req.user.id,
      isActive: true
    });

    if (!template) {
      return res.status(404).json({ message: 'Template not found or access denied' });
    }

    template.isActive = false;
    await template.save();

    res.json({ message: 'Template deleted successfully' });
  } catch (error) {
    console.error('Delete template error:', error);
    res.status(500).json({ message: 'Error deleting template', error: error.message });
  }
});

// Clone template
router.post('/:id/clone', auth, async (req, res) => {
  try {
    const originalTemplate = await Template.findOne({
      _id: req.params.id,
      $or: [
        { isPublic: true, isActive: true },
        { createdBy: req.user.id, isActive: true }
      ]
    });

    if (!originalTemplate) {
      return res.status(404).json({ message: 'Template not found' });
    }

    // Increment usage count for original template
    await originalTemplate.incrementUsage();

    // Create cloned template
    const clonedTemplate = new Template({
      name: `${originalTemplate.name} (Copy)`,
      subject: originalTemplate.subject,
      preheader: originalTemplate.preheader,
      components: originalTemplate.components,
      settings: originalTemplate.settings,
      category: originalTemplate.category,
      tags: originalTemplate.tags,
      createdBy: req.user.id,
      isPublic: false,
      isPremium: false
    });

    await clonedTemplate.save();

    const populatedTemplate = await Template.findById(clonedTemplate._id)
      .populate('createdBy', 'name email');

    res.status(201).json({ 
      message: 'Template cloned successfully', 
      template: populatedTemplate 
    });
  } catch (error) {
    console.error('Clone template error:', error);
    res.status(500).json({ message: 'Error cloning template', error: error.message });
  }
});

// Toggle favorite
router.post('/:id/favorite', auth, async (req, res) => {
  try {
    const template = await Template.findOne({
      _id: req.params.id,
      isPublic: true,
      isActive: true
    });

    if (!template) {
      return res.status(404).json({ message: 'Template not found' });
    }

    const userId = req.user.id;
    const isFavorited = template.favorites.includes(userId);

    if (isFavorited) {
      template.favorites.pull(userId);
    } else {
      template.favorites.push(userId);
    }

    await template.save();

    res.json({ 
      message: isFavorited ? 'Removed from favorites' : 'Added to favorites',
      isFavorited: !isFavorited
    });
  } catch (error) {
    console.error('Toggle favorite error:', error);
    res.status(500).json({ message: 'Error updating favorites', error: error.message });
  }
});

// Rate template
router.post('/:id/rate', auth, async (req, res) => {
  try {
    const { rating } = req.body;
    
    if (rating < 1 || rating > 5) {
      return res.status(400).json({ message: 'Rating must be between 1 and 5' });
    }

    const template = await Template.findOne({
      _id: req.params.id,
      isPublic: true,
      isActive: true
    });

    if (!template) {
      return res.status(404).json({ message: 'Template not found' });
    }

    // Simple rating system - in production, you'd want to track individual user ratings
    template.rating = ((template.rating * template.ratingCount) + rating) / (template.ratingCount + 1);
    template.ratingCount += 1;
    await template.save();

    res.json({ 
      message: 'Rating submitted successfully',
      averageRating: template.averageRating
    });
  } catch (error) {
    console.error('Rate template error:', error);
    res.status(500).json({ message: 'Error submitting rating', error: error.message });
  }
});

module.exports = router;