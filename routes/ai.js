const express = require('express');
const axios = require('axios');
const Template = require('../models/EmailTemplate');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Generate template with AI
router.post('/generate-template', auth, async (req, res) => {
  try {
    const { prompt, category = 'other', templateName } = req.body;

    if (!prompt || prompt.trim().length < 10) {
      return res.status(400).json({ 
        success: false,
        message: 'Please provide a detailed prompt (at least 10 characters)' 
      });
    }

    console.log('Generating template with prompt:', prompt);
    console.log('Category:', category);
    console.log('Template Name:', templateName);

    // Call AI API to generate template
    const aiResponse = await callSonarAI(prompt);
    console.log('AI Response received');
    
    const templateData = parseAIResponse(aiResponse);
    console.log('Parsed template data:', JSON.stringify(templateData, null, 2));

    // Create template in database
    const template = new Template({
      name: templateName || templateData.templateName || 'AI Generated Template',
      subject: templateData.subject || 'AI Generated Subject',
      preheader: templateData.preheader || prompt.slice(0, 90) + '...',
      components: templateData.components.map(comp => ({
        id: generateId(),
        type: comp.type,
        content: comp.content || '',
        styles: comp.styles || {},
        attributes: comp.attributes || {}
      })),
      settings: {
        width: '600px',
        backgroundColor: '#f4f4f4',
        fontFamily: 'Arial, sans-serif',
        responsive: true
      },
      category,
      isAIGenerated: true,
      aiPrompt: prompt,
      createdBy: req.user.id,
      isPublic: false
    });

    await template.save();
    console.log('Template saved to database');

    const populatedTemplate = await Template.findById(template._id)
      .populate('createdBy', 'name email');

    res.status(201).json({
      success: true,
      message: 'AI template generated successfully',
      template: populatedTemplate
    });

  } catch (error) {
    console.error('AI generation error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error generating AI template', 
      error: error.message 
    });
  }
});

// Helper functions
async function callSonarAI(prompt) {
  const SONAR_API_KEY = process.env.SONAR_API_KEY;
  
  if (!SONAR_API_KEY) {
    console.error('SONAR_API_KEY not found in environment variables');
    throw new Error('Sonar AI API key not configured. Please set SONAR_API_KEY in your .env file');
  }

  // Validate API key format
  if (!SONAR_API_KEY.startsWith('pplx-')) {
    console.error('Invalid API key format:', SONAR_API_KEY.substring(0, 10) + '...');
    throw new Error('Invalid Sonar API key format. Key should start with "pplx-"');
  }

  const enhancedPrompt = `
    Based on this user request: "${prompt}"
    
    Generate a professional email template with the following components:
    - Use appropriate components for the email type (header, text, button, image, footer, etc.)
    - Include realistic content that matches the request
    - Use modern, professional styling
    - For images, use placeholder URLs like "https://via.placeholder.com/600x300"
    
    Return ONLY a valid JSON object with this exact structure:
    {
      "templateName": "Template Name Here",
      "subject": "Email Subject Line",
      "preheader": "Preview text that appears in inbox",
      "components": [
        {
          "type": "header",
          "content": "Header Text",
          "styles": {
            "backgroundColor": "#4F46E5",
            "color": "#ffffff",
            "fontSize": "24px",
            "padding": "30px",
            "textAlign": "center",
            "fontWeight": "bold"
          },
          "attributes": {}
        },
        {
          "type": "text",
          "content": "Body text content here",
          "styles": {
            "backgroundColor": "#ffffff",
            "color": "#333333",
            "fontSize": "16px",
            "padding": "20px",
            "textAlign": "left"
          },
          "attributes": {}
        },
        {
          "type": "button",
          "content": "Call to Action",
          "styles": {
            "backgroundColor": "#4F46E5",
            "color": "#ffffff",
            "fontSize": "16px",
            "padding": "12px 24px",
            "textAlign": "center",
            "borderRadius": "6px"
          },
          "attributes": {
            "href": "https://example.com"
          }
        }
      ]
    }
    
    Important: Return ONLY the JSON object, no explanatory text.`;

  try {
    console.log('Calling Perplexity API...');
    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: 'sonar',  // Use the correct model name
      messages: [
        {
          role: 'system',
          content: 'You are an expert email template designer. Create professional, modern email templates based on user requests. Always respond with valid JSON only, no additional text.'
        },
        {
          role: 'user',
          content: enhancedPrompt
        }
      ],
      max_tokens: 2000,
      temperature: 0.7,
      top_p: 0.9,
      stream: false
    }, {
      headers: {
        'Authorization': `Bearer ${SONAR_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000
    });

    if (!response.data || !response.data.choices || !response.data.choices[0]) {
      console.error('Invalid API response structure:', response.data);
      throw new Error('Invalid response structure from AI API');
    }

    const content = response.data.choices[0].message.content;
    console.log('AI API Response received, length:', content.length);
    
    return content;

  } catch (error) {
    console.error('Sonar AI API Error Details:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    });
    
    if (error.response) {
      const status = error.response.status;
      const errorData = error.response.data;
      
      switch (status) {
        case 400:
          throw new Error(`Bad Request: ${errorData?.detail || 'Invalid request format'}`);
        case 401:
          throw new Error('Unauthorized: Invalid API key. Please check your SONAR_API_KEY');
        case 403:
          throw new Error('Forbidden: API key does not have required permissions');
        case 429:
          throw new Error('Rate limit exceeded. Please try again in a few moments.');
        case 500:
          throw new Error('AI service temporarily unavailable. Please try again later.');
        default:
          throw new Error(`API Error (${status}): ${errorData?.detail || 'Unknown error'}`);
      }
    }
    
    if (error.code === 'ECONNABORTED') {
      throw new Error('Request timeout. The AI is taking too long to respond. Please try again.');
    }
    
    throw new Error(`Failed to connect to AI service: ${error.message}`);
  }
}

function parseAIResponse(aiResponse) {
  try {
    console.log('Parsing AI response...');
    
    // Clean the response - remove any markdown formatting or extra text
    let cleanResponse = aiResponse.trim();
    
    // Remove markdown code blocks if present
    cleanResponse = cleanResponse.replace(/```json\n?/gi, '');
    cleanResponse = cleanResponse.replace(/```\n?/g, '');
    
    // Find JSON object in the response
    const jsonStart = cleanResponse.indexOf('{');
    const jsonEnd = cleanResponse.lastIndexOf('}');
    
    if (jsonStart === -1 || jsonEnd === -1) {
      console.error('No JSON found in response:', cleanResponse.substring(0, 200));
      throw new Error('No JSON object found in AI response');
    }
    
    const jsonString = cleanResponse.substring(jsonStart, jsonEnd + 1);
    console.log('Extracted JSON length:', jsonString.length);
    
    const parsed = JSON.parse(jsonString);
    
    // Validate required fields
    if (!parsed.components || !Array.isArray(parsed.components)) {
      console.log('Creating default components as none were provided');
      parsed.components = getDefaultComponents();
    }
    
    if (!parsed.templateName) {
      parsed.templateName = 'AI Generated Template';
    }
    
    if (!parsed.subject) {
      parsed.subject = 'Your Email Subject';
    }
    
    if (!parsed.preheader) {
      parsed.preheader = 'Preview text for your email';
    }
    
    // Ensure each component has required fields
    parsed.components = parsed.components.map((comp, index) => {
      if (!comp.type) {
        console.warn(`Component ${index} missing type, defaulting to text`);
        comp.type = 'text';
      }
      
      // Ensure valid component type
      const validTypes = ['text', 'image', 'button', 'divider', 'spacer', 'header', 'footer', 'social', 'product', 'video', 'personalized'];
      if (!validTypes.includes(comp.type)) {
        console.warn(`Invalid component type "${comp.type}", defaulting to text`);
        comp.type = 'text';
      }
      
      return {
        type: comp.type,
        content: comp.content || getDefaultContent(comp.type),
        styles: {
          backgroundColor: comp.styles?.backgroundColor || '#ffffff',
          color: comp.styles?.color || '#333333',
          fontSize: comp.styles?.fontSize || '16px',
          padding: comp.styles?.padding || '10px',
          textAlign: comp.styles?.textAlign || 'left',
          fontWeight: comp.styles?.fontWeight || 'normal',
          borderRadius: comp.styles?.borderRadius || '0px',
          ...comp.styles
        },
        attributes: {
          href: comp.attributes?.href || '#',
          src: comp.attributes?.src || '',
          alt: comp.attributes?.alt || '',
          target: comp.attributes?.target || '_blank',
          ...comp.attributes
        }
      };
    });
    
    console.log('Successfully parsed template with', parsed.components.length, 'components');
    return parsed;
    
  } catch (error) {
    console.error('Failed to parse AI response:', error.message);
    console.error('Raw response (first 500 chars):', aiResponse.substring(0, 500));
    
    // Return a fallback template with better default content
    return getFallbackTemplate();
  }
}

function getDefaultComponents() {
  return [
    {
      type: 'header',
      content: 'Welcome to Our Newsletter',
      styles: {
        backgroundColor: '#4F46E5',
        color: '#ffffff',
        fontSize: '28px',
        padding: '30px',
        textAlign: 'center',
        fontWeight: 'bold'
      }
    },
    {
      type: 'text',
      content: 'Thank you for subscribing! We\'re excited to share our latest updates with you.',
      styles: {
        backgroundColor: '#ffffff',
        color: '#333333',
        fontSize: '16px',
        padding: '20px',
        textAlign: 'center'
      }
    },
    {
      type: 'button',
      content: 'Get Started',
      styles: {
        backgroundColor: '#4F46E5',
        color: '#ffffff',
        fontSize: '16px',
        padding: '12px 30px',
        textAlign: 'center',
        borderRadius: '6px'
      },
      attributes: {
        href: 'https://example.com'
      }
    },
    {
      type: 'footer',
      content: '© 2024 Your Company. All rights reserved.',
      styles: {
        backgroundColor: '#f3f4f6',
        color: '#6b7280',
        fontSize: '14px',
        padding: '20px',
        textAlign: 'center'
      }
    }
  ];
}

function getDefaultContent(type) {
  const defaults = {
    header: 'Header Text',
    text: 'Your content goes here',
    button: 'Click Here',
    footer: '© 2024 Your Company',
    divider: '',
    spacer: '',
    image: '',
    social: 'Follow us on social media',
    product: 'Product Name',
    video: 'Watch Video',
    personalized: 'Hello {{name}}'
  };
  return defaults[type] || 'Content';
}

function getFallbackTemplate() {
  return {
    templateName: 'Professional Email Template',
    subject: 'Your Subject Line Here',
    preheader: 'This is what appears in the email preview',
    components: [
      {
        type: 'header',
        content: 'Welcome!',
        styles: {
          backgroundColor: '#4F46E5',
          color: '#ffffff',
          fontSize: '32px',
          padding: '40px 20px',
          textAlign: 'center',
          fontWeight: 'bold',
          borderRadius: '0px'
        },
        attributes: {}
      },
      {
        type: 'image',
        content: '',
        styles: {
          padding: '20px',
          textAlign: 'center'
        },
        attributes: {
          src: 'https://via.placeholder.com/600x300/4F46E5/ffffff?text=Your+Image+Here',
          alt: 'Hero Image'
        }
      },
      {
        type: 'text',
        content: 'This email template was generated based on your request. You can edit any part of this template using the email builder.',
        styles: {
          backgroundColor: '#ffffff',
          color: '#4b5563',
          fontSize: '16px',
          padding: '20px 30px',
          textAlign: 'left',
          lineHeight: '1.6'
        },
        attributes: {}
      },
      {
        type: 'button',
        content: 'Call to Action',
        styles: {
          backgroundColor: '#10b981',
          color: '#ffffff',
          fontSize: '16px',
          padding: '14px 28px',
          textAlign: 'center',
          fontWeight: 'bold',
          borderRadius: '8px',
          display: 'inline-block'
        },
        attributes: {
          href: 'https://example.com',
          target: '_blank'
        }
      },
      {
        type: 'spacer',
        content: '',
        styles: {
          height: '30px'
        },
        attributes: {}
      },
      {
        type: 'footer',
        content: 'You received this email because you signed up for our service. © 2024 Your Company, All rights reserved.',
        styles: {
          backgroundColor: '#f9fafb',
          color: '#6b7280',
          fontSize: '14px',
          padding: '30px',
          textAlign: 'center',
          borderTop: '1px solid #e5e7eb'
        },
        attributes: {}
      }
    ]
  };
}

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

// Get AI suggestions based on category
router.get('/suggestions/:category', auth, async (req, res) => {
  try {
    const { category } = req.params;
    const suggestions = getAISuggestions(category);
    
    res.json({ 
      success: true,
      suggestions 
    });
  } catch (error) {
    console.error('AI suggestions error:', error);
    res.status(500).json({ 
      success: false,
      message: 'Error fetching AI suggestions', 
      error: error.message 
    });
  }
});

function getAISuggestions(category) {
  const suggestions = {
    marketing: [
      'Create a product launch announcement with hero image and call-to-action',
      'Design a customer testimonial email with ratings and reviews',
      'Build a limited-time offer email with countdown timer',
      'Make a new feature announcement with benefits list'
    ],
    promotional: [
      'Create a flash sale email with discount code and urgency',
      'Design a seasonal promotion with product showcase',
      'Build a loyalty program invitation with rewards preview',
      'Make a clearance sale announcement with product grid'
    ],
    newsletter: [
      'Create a monthly newsletter with featured articles',
      'Design a weekly digest with top stories and updates',
      'Build an industry news roundup with expert insights',
      'Make a company update newsletter with achievements'
    ],
    ecommerce: [
      'Create an abandoned cart recovery email with items',
      'Design a product recommendation email based on browsing',
      'Build an order confirmation with tracking details',
      'Make a customer review request after purchase'
    ],
    business: [
      'Create a professional meeting invitation',
      'Design a project update email for stakeholders',
      'Build a quarterly report summary',
      'Make a partnership proposal email'
    ],
    other: [
      'Create a welcome email for new subscribers',
      'Design an event invitation with RSVP button',
      'Build a survey request with incentive offer',
      'Make a thank you email for customers'
    ]
  };

  return suggestions[category] || suggestions.other;
}

module.exports = router;