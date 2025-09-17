const mongoose = require('mongoose');

const templateSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  subject: {
    type: String,
    trim: true
  },
  preheader: {
    type: String,
    trim: true
  },
  components: [{
    id: String,
    type: {
      type: String,
      enum: ['text', 'image', 'button', 'divider', 'spacer', 'container', 'header', 'footer', 'social', 'columns', 'product', 'video', 'personalized'],
      required: true
    },
    content: String,
    styles: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    attributes: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    children: [{
      type: mongoose.Schema.Types.Mixed
    }]
  }],
  settings: {
    width: {
      type: String,
      default: '600px'
    },
    backgroundColor: {
      type: String,
      default: '#ffffff'
    },
    fontFamily: {
      type: String,
      default: 'Arial, sans-serif'
    },
    responsive: {
      type: Boolean,
      default: true
    }
  },
  category: {
  type: String,
  enum: ['marketing', 'promotional', 'newsletter', 'ecommerce', 'business', 'other'],
  default: 'other'
},
  tags: [{
    type: String,
    trim: true
  }],
  isPublic: {
    type: Boolean,
    default: false
  },
  isPremium: {
    type: Boolean,
    default: false
  },
  isAIGenerated: {
    type: Boolean,
    default: false
  },
  aiPrompt: {
    type: String,
    trim: true
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  thumbnailUrl: {
    type: String,
    default: null
  },
  usageCount: {
    type: Number,
    default: 0
  },
  rating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5
  },
  ratingCount: {
    type: Number,
    default: 0
  },
  favorites: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Indexes for better performance
templateSchema.index({ createdBy: 1, isActive: 1 });
templateSchema.index({ isPublic: 1, isActive: 1 });
templateSchema.index({ category: 1, isPublic: 1 });
templateSchema.index({ tags: 1 });
templateSchema.index({ createdAt: -1 });

// Virtual for average rating
templateSchema.virtual('averageRating').get(function() {
  return this.ratingCount > 0 ? (this.rating / this.ratingCount).toFixed(1) : 0;
});

// Increment usage count
templateSchema.methods.incrementUsage = function() {
  this.usageCount += 1;
  return this.save();
};

module.exports = mongoose.model('EmailTemplate', templateSchema);