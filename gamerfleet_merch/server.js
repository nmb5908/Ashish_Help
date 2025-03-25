const express = require('express');
const path = require('path');

const mysql = require('mysql2');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: process.env.DB_PASSWORD,
  database: 'merch_store',
  namedPlaceholders: true,
  decimalNumbers: true, // Handle DECIMAL as numbers
  dateStrings: true, // Return dates as strings
  typeCast: function (field, next) {
    if (field.type === 'JSON') {
      return JSON.parse(field.string());
    }
    return next();
  }
});


const { auth } = require('express-openid-connect');
const sha256 = require('sha256');

// Add Auth0 configuration
const config = {
  authRequired: false,
  auth0Logout: true,
  secret: process.env.AUTH0_SECRET,
  baseURL: process.env.BASE_URL || 'http://localhost:5000',
  clientID: 'xNijACTyApRKBtBN0zNghXqqWv7sLJpb',
  issuerBaseURL: 'https://naman0101.us.auth0.com'
};

// Apply auth router
app.use(auth(config));


app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/images', express.static(path.join(__dirname, 'public', 'images')));

// Get all products
app.get('/products', (req, res) => {
  db.query('SELECT id, name, original_price, image_url FROM products', (err, results) => {
    if(err) throw err;
    
    // Convert DECIMAL fields to Numbers
    const processed = results.map(product => ({
      ...product,
      original_price: Number(product.original_price)
    }));
    
    res.json(processed);
  });
});

// Get single product with reviews
app.get('/products/:id', (req, res) => {
  const productId = req.params.id;

  // First get product details
  db.query('SELECT * FROM products WHERE id = ?', [productId], (err, productResults) => {
    if(err) {
      console.error('Product query error:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if(productResults.length === 0) return res.status(404).json({ error: 'Product not found' });

    // Then get reviews separately
    db.query('SELECT user_name, rating, comment, created_at FROM product_reviews WHERE product_id = ?', 
      [productId], 
      (err, reviewResults) => {
        if(err) {
          console.error('Review query error:', err);
          return res.status(500).json({ error: 'Database error' });
        }

        try {
          const product = {
            ...productResults[0],
            colors: productResults[0].colors ? productResults[0].colors.split(',') : [],
            sizes: productResults[0].sizes ? productResults[0].sizes.split(',') : [],
            reviews: reviewResults.map(review => ({
              ...review,
              date: new Date(review.created_at).toISOString()
            }))
          };

          res.json(product);
        } catch (parseError) {
          console.error('Data processing error:', parseError);
          res.status(500).json({ error: 'Data processing error' });
        }
      });
  });
});

// Add review endpoint
app.post('/products/:id/reviews', (req, res) => {
  const { user_name, rating, comment } = req.body;
  
  // Validate rating
  if(![1,2,3,4,5].includes(Number(rating))) {
    return res.status(400).json({ error: 'Invalid rating' });
  }

  db.query(
    'INSERT INTO product_reviews (product_id, user_name, rating, comment) VALUES (?, ?, ?, ?)',
    [req.params.id, user_name, rating, comment],
    (err, result) => {
      if(err) {
        console.error('Review insert error:', err);
        return res.status(500).json({ error: 'Database error' });
      }
      res.json({ message: 'Review added successfully' });
    }
  );
});

const ensureUserExists = async (auth0User) => {
  return new Promise((resolve, reject) => {
    db.query(
      'INSERT IGNORE INTO users (auth0_id, email) VALUES (?, ?)',
      [auth0User.sub, auth0User.email],
      (err, result) => {
        if(err) return reject(err);
        db.query('SELECT id FROM users WHERE auth0_id = ?', [auth0User.sub], (err, results) => {
          if(err) return reject(err);
          resolve(results[0].id);
        });
      }
    );
  });
};

// Protected cart endpoints
app.get('/api/cart', async (req, res) => {
  if(!req.oidc.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  
  try {
    const userId = await ensureUserExists(req.oidc.user);
    db.query(
      `SELECT p.id, p.name, p.image_url, p.original_price, c.quantity 
       FROM carts c
       JOIN products p ON c.product_id = p.id
       WHERE c.user_id = ?`,
      [userId],
      (err, results) => {
        if(err) throw err;
        res.json(results);
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/cart', async (req, res) => {
  if(!req.oidc.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });
  
  const { product_id, quantity } = req.body;
  try {
    const userId = await ensureUserExists(req.oidc.user);
    db.query(
      `INSERT INTO carts (user_id, product_id, quantity)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity)`,
      [userId, product_id, quantity],
      (err, result) => {
        if(err) throw err;
        res.json({ message: 'Item added to cart' });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update orders endpoint
app.post('/orders', async (req, res) => {
  if(!req.oidc.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const userId = await ensureUserExists(req.oidc.user);
    const { items, total } = req.body;
    
    db.beginTransaction(async (err) => {
      // Create order
      const [order] = await db.promise().query(
        'INSERT INTO orders (user_id, total_price) VALUES (?, ?)',
        [userId, total]
      );
      
      // Insert order items
      await db.promise().query(
        'INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ?',
        [items.map(item => [
          order.insertId,
          item.product_id,
          item.quantity,
          item.price
        ])]
      );
      
      // Clear cart
      await db.promise().query(
        'DELETE FROM carts WHERE user_id = ?',
        [userId]
      );
      
      db.commit();
      res.json({ message: 'Order placed successfully!', orderId: order.insertId });
    });
  } catch (error) {
    db.rollback();
    res.status(500).json({ error: 'Order failed' });
  }
});

app.delete('/api/cart/:itemId', async (req, res) => {
  if (!req.oidc.isAuthenticated()) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const userId = await ensureUserExists(req.oidc.user);
    db.query(
      'DELETE FROM carts WHERE user_id = ? AND product_id = ?',
      [userId, req.params.itemId],
      (err, result) => {
        if (err) throw err;
        res.json({ message: 'Item removed from cart' });
      }
    );
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
// give the link of the localhost:5000 to the frontend team
console.log('Server is running on http://localhost:5000');