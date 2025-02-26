const express = require('express');
const { check, validationResult } = require('express-validator'); 
const session = require('express-session');
const flash = require('connect-flash');
const pool = require('./config/db');
const fs = require('fs'); // for reading JSON files
const moment = require('moment');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const port = 3000;
const JUMP_TICKET_PRICE = 40; // Price of a jump ticket

// Configure session middleware
app.use(session({
  secret: '6vBDJNffNfUhHDDBHk', // Replace with a strong, unique secret key
  resave: false,
  saveUninitialized: true
}));

app.use(flash()); 
app.use(express.urlencoded({ extended: true }));
app.use(express.json()); 

// Serve static files (HTML, CSS, JS)
app.set('views', './views');
app.set('view engine', 'ejs');
app.use(express.static('public'));


// Read menu data from JSON file
const rawdata = fs.readFileSync('config/menu.json');
const menuItems = JSON.parse(rawdata); 
// Parse form data
app.use(express.urlencoded({ extended: false }));

// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<[ FUNCTIONS ]>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
// Middleware to check if user is logged in
const isLoggedIn = (req, res, next) => {
  if (req.session.user) { // Check if user is logged in (replace with your actual logic)
    next(); 
  } else {
    req.flash('error', 'Please log in to access this page.');
    res.redirect('/login'); // Redirect to login page
  }
};
// Checks if the user has the necessary role level for what he is trying to access
const hasRoleLevel = (rolelevel) => {
  return (req, res, next) => {
    if (req.session.user && req.session.user.rolelevel && req.session.user.rolelevel <= rolelevel) {
      next(); 
    } else {
      req.flash('error', 'You do not have permission to access this page.');
      res.redirect('/'); // TODO: redirect to an error page
    }
  };
};
// Returns a list of the available Fuel Types on the database
async function getFuelTypes() {
  const [rows] = await pool.execute('SELECT fuel_name FROM fuel_types'); 
  return rows.map(row => row.fuel_name);
}
//Create transaction function
async function createTransaction(transactionData) {
  try {
    await pool.query('START TRANSACTION;');

    // Insert transaction data into the database
    const [result] = await pool.execute(`
      INSERT INTO transactions 
      (transaction_type, funjumper_id, pilot_id, tandem_id, amount, notes, transaction_datetime) 
      VALUES (?, ?, ?, ?, ?, ?, NOW())
    `, [
      transactionData.transaction_type,
      transactionData.funjumper_id,
      transactionData.pilot_id,
      transactionData.tandem_id,
      transactionData.amount,
      transactionData.notes
    ]);

    // Update funjumper's jump_ticket_balance if necessary
    if (transactionData.transaction_type === 'jump' || transactionData.transaction_type === 'cancel_jump') {
      const [jumpticket_balanceResult] = await pool.execute(`
        SELECT SUM(CASE WHEN t.transaction_type IN ('jump', 'cancel_jump', 'buy_jumpticket', 'cancel_jumpticket') THEN t.amount ELSE 0 END) AS balance
        FROM transactions t
        WHERE t.funjumper_id = ?
      `, [transactionData.funjumper_id]);

      const jumpticket_newBalance = jumpticket_balanceResult[0].balance; 

      await pool.execute(`
        UPDATE fun_jumpers
        SET jump_ticket_balance = ?
        WHERE funjumper_id = ?
      `, [jumpticket_newBalance, transactionData.funjumper_id]);
    }

    // Commit the transaction
    await pool.query('COMMIT;');

    return result.insertId; // Return the transaction ID

  } catch (error) {
    await pool.query('ROLLBACK;'); 
    console.error('Error creating transaction:', error);
    throw error; 
  }
}
// Handle undefined values
function handleUndefined(value) {
  return value === undefined ? null : value;
}

// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<[ API Requests ]>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
// Endpoint to get fuel type details based on name
app.get('/api/get-fuel-type-details/:fuelTypeId', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  try {
    const { fuelTypeId } = req.params;

    const [fuelTypeResult] = await pool.execute('SELECT fuel_name, density, price_per_liter FROM fuel_types WHERE fuel_type_id = ?', [fuelTypeId]);

    if (fuelTypeResult.length === 0) {
      return res.status(404).json({ error: 'Fuel Type not found' });
    }

    res.json(fuelTypeResult[0]); 

  } catch (err) {
    console.error('Error fetching fuel type details:', err);
    res.status(500).json({ error: 'An error occurred while fetching fuel type details.' });
  }
});
app.get('/api/search/funjumpers', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  try {
    const searchTerm = req.query.q; 

    const [results] = await pool.execute(`
      SELECT 
          funjumper_id, 
          first_name, 
          last_name 
      FROM fun_jumpers
      WHERE CONCAT(first_name, ' ', last_name) LIKE ?
    `, [`%${searchTerm}%`]); 

    res.json(results); 

  } catch (error) {
    console.error('Error searching for funjumpers:', error);
    res.status(500).json({ error: 'Error searching for funjumpers.' });
  }
});
// Add funjumper to load
app.post('/api/loads/:loadId/add-funjumper', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  try {
    const { loadId } = req.params;
    const { funjumperId, exitAltitude, groupId, notes } = req.body;

    // Check for existing jump with the same funjumper and load
    const [existingJump] = await pool.query(`
      SELECT * FROM jumps
      WHERE load_id = ? AND funjumper_id = ?
    `, [loadId, funjumperId]);

    if (existingJump.length > 0) {
      // Funjumper already manifested to this load
      return res.status(400).json({ success: false, message: 'Funjumper is already manifested to this load.' });
    }

    // Insert the jump record into the database
    await pool.execute(`
      INSERT INTO jumps (load_id, funjumper_id, jump_type_id, group_id, notes)
      VALUES (?, ?, (SELECT jump_type_id FROM jump_types WHERE height_feet = ?), ?, ?)
    `, [loadId, funjumperId, exitAltitude, groupId || null, notes || null]); 

    
    // Record transaction for jump ticket usage
    const transactionData = {
      transaction_type: 'jump',
      funjumper_id: funjumperId,
      pilot_id: null,
      tandem_id: null,
      amount: -1,
      notes: `Jump ticket used for Load ${loadId}`
    };
    await createTransaction(transactionData);

    res.status(200).json({ success: true, message: 'Funjumper added to load successfully.' });

  } catch (error) {
    console.error('Error adding funjumper to load:', error);
    res.status(500).json({ success: false, message: error.message }); 
  }
});
app.get('/api/get-airplane-fuel-type-id-name/:airplaneId', async (req, res) => {
  try {
    const { airplaneId } = req.params;

    const [airplane] = await pool.execute('SELECT a.airplane_id, a.tail_number, ft.fuel_type_id, ft.fuel_name as fuel_type_name FROM \
                                          airplanes a JOIN fuel_types ft ON a.fuel_type_id = ft.fuel_type_id WHERE a.airplane_id = ?', [airplaneId]);

    if (airplane.length === 0) {
      return res.status(404).json({ error: 'Airplane not found' });
    }

    res.json({ 
      fuel_type_name: airplane[0].fuel_type_name,
      fuel_type_id: airplane[0].fuel_type_id 
    }); 

  } catch (err) {
    console.error('Error fetching airplane details:', err);
    res.status(500).json({ error: 'An error occurred while fetching airplane details.' });
  }
});
// Route to view load details
app.get('/operation/manifest/details/:loadId', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  try {
    const { loadId } = req.params;

    // Fetch load details
    const [load] = await pool.execute(`
      SELECT 
          l.load_id, 
          a.tail_number, 
          a.aircraft_type, 
          CONCAT(p.first_name, ' ', p.last_name) AS pilot_name, 
          a.slots, 
          l.takeoff_datetime, 
          l.status, 
          l.notes 
      FROM loads l
      JOIN airplanes a ON l.airplane_id = a.airplane_id
      JOIN pilots p ON l.pilot_id = p.pilot_id
      WHERE l.load_id = ?
    `, [loadId]);

    // Fetch fun jumpers associated with the load
    const [funjumpers] = await pool.execute(`
      SELECT 
          j.jump_id,
          fj.funjumper_id, 
          CONCAT(fj.first_name, ' ', fj.last_name) AS funjumper_name, 
          fj.canopy_size, 
          fj.jump_ticket_balance,
          j.group_id,
          j.notes,
          jt.height_feet
      FROM jumps j
      JOIN jump_types jt ON j.jump_type_id = jt.jump_type_id
      JOIN fun_jumpers fj ON j.funjumper_id = fj.funjumper_id
      WHERE j.load_id = ?
    `, [loadId]);

    // Fetch tandem jumpers associated with the load
    const [tandems] = await pool.execute(`
      SELECT 
        t.tandem_id,
        CONCAT(p.first_name, ' ', p.last_name) AS passenger_name,
        CONCAT(fj.first_name, ' ', fj.last_name) AS instructor_name,
        t.photos,
        t.videos,
        t.notes
      FROM tandems t
      JOIN passengers p ON t.passenger_id = p.passenger_id
      LEFT JOIN tandem_instructors ti ON t.tandem_instructor_id = ti.tandem_instructor_id
      LEFT JOIN fun_jumpers fj ON ti.funjumper_id = fj.funjumper_id
      JOIN jumps j ON t.tandem_id = j.tandem_id
      WHERE j.load_id = ?
    `, [loadId]);

    const [jumpTypes] = await pool.execute(`
      SELECT jump_type_id, jump_name, height_feet 
      FROM jump_types
    `);

    if (load.length === 0) {
      return res.status(404).send('Load not found.');
    }

    return res.render('index', { 
      title: 'Manifest Details - Load ' + loadId,
      page: 'operation-load-details',
      menuItems: menuItems,
      errors: '',
      user: req.session.user,
      load: load[0], 
      funjumpers: funjumpers,
      tandems: tandems,
      jumpTypes: jumpTypes
    });

  } catch (error) {
    console.error('Error fetching load details:', error);
    res.status(500).send('Error fetching load details.');
  }
});
// --- TANDEM RELATED ---
// Search for passengers 
app.get('/api/search/passengers', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  try {
    const searchTerm = req.query.q;

    const [results] = await pool.execute(`
      SELECT 
        passenger_id, 
        first_name, 
        last_name 
      FROM passengers p
      WHERE CONCAT(first_name, ' ', last_name) LIKE ? 
      AND p.passenger_id IN (
        SELECT t.passenger_id
        FROM tandems t
        WHERE t.tandem_instructor_id IS NULL
      );
    `, [`%${searchTerm}%`]);

    res.json(results);

  } catch (error) {
    console.error('Error searching for passengers:', error);
    res.status(500).json({ error: 'Error searching for passengers.' });
  }
});
// Search for instructors
app.get('/api/search/instructors', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  try {
    const searchTerm = req.query.q;

    const [results] = await pool.execute(`
      SELECT 
        ti.tandem_instructor_id AS instructor_id, 
        fj.first_name, 
        fj.last_name 
      FROM tandem_instructors AS ti
      JOIN fun_jumpers AS fj ON ti.funjumper_id = fj.funjumper_id
      WHERE CONCAT(fj.first_name, ' ', fj.last_name) LIKE ?
    `, [`%${searchTerm}%`]);

    res.json(results);

  } catch (error) {
    console.error('Error searching for instructors:', error);
    res.status(500).json({ error: 'Error searching for instructors.' });
  }
});
app.post('/api/loads/:loadId/add-tandem', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  try {
    const { loadId } = req.params;
    const { passengerId, instructorId, notes } = req.body;

    // 1. Find the appropriate tandem entry
    const [tandemEntries] = await pool.query(`
      SELECT tandem_id FROM tandems
      WHERE passenger_id = ? AND tandem_instructor_id IS NULL
    `, [passengerId]);

    if (tandemEntries.length === 0) {
      return res.status(400).json({ success: false, message: 'No matching tandem entry found for the passenger.' });
    }

    const tandemId = tandemEntries[0].tandem_id;

    // 2. Update the tandem entry
    await pool.execute(`
      UPDATE tandems
      SET tandem_instructor_id = ?
      WHERE tandem_id = ?
    `, [instructorId, tandemId]);

    // 3. Create a jump entry
    await pool.execute(`
      INSERT INTO jumps (load_id, tandem_id, notes)
      VALUES (?, ?, ?)
    `, [loadId, tandemId, notes || null]);

    //4. Create transaction for this instructor
    await createTransaction({
      transaction_type: 'tandem_jump',
      funjumper_id: null,
      pilot_id: null,
      tandem_id: instructorId,
      amount: +1,
      notes: `Tandem Instructor on load ${loadId} with passenger ${passengerId}`
    });

    // Retrieve photos and videos from the tandem entry
    const [tandemData] = await pool.execute(`
      SELECT photos, videos
      FROM tandems
      WHERE passenger_id = ?
      ORDER BY tandem_id DESC
      LIMIT 1
    `, [passengerId]);

    if (!tandemData || tandemData.length === 0) {
      return res.status(404).json({ success: false, message: 'Tandem data not found.' });
    }

    const { photos, videos } = tandemData[0];

    if (photos === 1) {
      await createTransaction({
        transaction_type: 'tandem_photos',
        funjumper_id: passengerId,
        pilot_id: null,
        tandem_id: instructorId,
        amount: +1,
        notes: `Tandem photos on load ${loadId} with passenger ${passengerId}`
      });
    }

    if (videos === 1) {
      await createTransaction({
        transaction_type: 'tandem_videos',
        funjumper_id: passengerId,
        pilot_id: null,
        tandem_id: instructorId,
        amount: +1,
        notes: `Tandem video on load ${loadId} with passenger ${passengerId}`
      });
    }


    res.status(200).json({ success: true, message: 'Tandem added to load successfully.' });

  } catch (error) {
    console.error('Error adding tandem to load:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<[ API Actions ]>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
// Route to toggle load status
app.post('/operation/manifest/toggle-status/:loadId', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  try {
    const { loadId } = req.params;

    // Retrieve the current load status
    const [result] = await pool.execute('SELECT status FROM loads WHERE load_id = ?', [loadId]);
    const currentStatus = result[0].status; 

    // Toggle the status
    const newStatus = currentStatus === 1 ? 0 : 1; 

    // Update the load status in the database
    await pool.execute('UPDATE loads SET status = ? WHERE load_id = ?', [newStatus, loadId]);

    res.status(200).json({ success: true });

  } catch (error) {
    console.error('Error toggling load status:', error);
    res.status(500).json({ success: false, message: 'Error toggling load status.' });
  }
});
// Remove funjumper from load
app.delete('/api/loads/:loadId/remove-funjumper/:jumpId', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  try {
    const { loadId, jumpId } = req.params;

    // Record transaction for jump ticket return
    const [result] = await pool.execute('SELECT funjumper_id FROM jumps WHERE jump_id = ?;', [jumpId]);
    const funjumperId = result[0].funjumper_id; 

    const transactionData = {
      transaction_type: 'cancel_jump',
      funjumper_id: funjumperId,
      pilot_id: null,
      tandem_id: null,
      amount: +1,
      notes: `Taken out of manifest from Load ${loadId}`
    };
    await createTransaction(transactionData);

    // Delete the jump record from the database
    await pool.execute(`
      DELETE FROM jumps WHERE jump_id = ?
    `, [jumpId]);

    res.status(200).json({ success: true, message: 'Funjumper removed from load successfully.' });

  } catch (error) {
    console.error('Error removing funjumper from load:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
//Removes tandem from load
app.delete('/api/loads/:loadId/remove-tandem/:tandemId', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  try {
    const { loadId, tandemId } = req.params;

    // Delete the jump record from the database, related to the tandem.
    await pool.execute(`
      DELETE FROM jumps WHERE tandem_id = ? AND load_id = ?
    `, [tandemId, loadId]);

    // Set tandem_instructor_id to NULL in the tandems table
    await pool.execute(`
      UPDATE tandems SET tandem_instructor_id = NULL WHERE tandem_id = ?
    `, [tandemId]);

    res.status(200).json({ success: true, message: 'Tandem removed from load successfully.' });

  } catch (error) {
    console.error('Error removing tandem from load:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});
// Updates the takeoff time of a load
app.put('/api/loads/:loadId/update-takeoff-time', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  try {
    const { loadId } = req.params;
    const { newTime } = req.body;

    const currentDate = new Date();
    const newDate = new Date(currentDate.getFullYear(), currentDate.getMonth(), currentDate.getDate(), 
                            parseInt(newTime.split(':')[0]), parseInt(newTime.split(':')[1])); 

    await pool.execute(`
      UPDATE loads 
      SET takeoff_datetime = ? 
      WHERE load_id = ?
    `, [newDate, loadId]);

    res.status(200).json({ success: true, message: 'Takeoff time updated successfully.' });

  } catch (error) {
    console.error('Error updating takeoff time:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<[ GET ]>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
// Home page
app.get('/', (req, res) => {
  console.log(req.session)
  if(!req.session.user) {
    return res.redirect('/operation/loads-dashboard');
  } else {
    return res.render('index', { 
        title: 'Ecosystem - Skydive Dunas', 
        page: 'main-page',
        menuItems: menuItems,
        user: req.session.user 
    });
  }
});
app.get('/operation/new-load', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  try {
    const [airplanes] = await pool.execute('SELECT airplane_id, tail_number FROM airplanes');
    const [pilots] = await pool.execute('SELECT pilot_id, first_name, last_name FROM pilots');
    const [lastLoad] = await pool.execute('SELECT airplane_id, pilot_id FROM loads ORDER BY takeoff_datetime DESC LIMIT 1');

    const lastload_airplane_id = lastLoad.length > 0 ? lastLoad[0].airplane_id : null; 
    const lastload_pilot_id = lastLoad.length > 0 ? lastLoad[0].pilot_id : null; 

    if(lastLoad.length > 0) {
      const [lastLoadAirplane] = await pool.execute('SELECT tail_number FROM airplanes WHERE airplane_id = ?', [lastload_airplane_id]);
      const [lastLoadPilot] = await pool.execute('SELECT first_name, last_name FROM pilots WHERE pilot_id = ?', [lastload_pilot_id]);

      return res.render('index', { 
          title: 'Operation - New Load',
          page: 'operation-new-load',
          menuItems: menuItems,
          errors: '',
          user: req.session.user,
          airplanes: airplanes,
          pilots: pilots,
          lastload: lastLoad[0],
          lastLoadAirplane: lastLoadAirplane[0].tail_number,
          lastLoadPilot: lastLoadPilot[0]
      }); 
    } else {
      return res.render('index', { 
        title: 'Operation - New Load',
        page: 'operation-new-load',
        menuItems: menuItems,
        errors: '',
        user: req.session.user,
        airplanes: airplanes,
        pilots: pilots,
        lastload: lastLoad[0],
        lastLoadAirplane: [''],
        lastLoadPilot: ['']
    }); 
    }  
    } catch (error) {
      console.error('Error registering new load:', error);
      req.flash('error', 'An error occurred while registering the new load.');
      res.render('index', { 
        title: 'Operation - New Load',
        page: 'operation-new-load',
        menuItems: menuItems,
        errors: ['Error on getting information from Database, related to pilots or airplanes'],
        user: req.session.user,
        airplanes: [''],
        pilots: [''],
        lastload: [''],
        lastLoadAirplane: [''],
        lastLoadPilot: ['']
        });
    }
});
app.get('/operation/manifest', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  try {

    // Get today's date
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const todayEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59);

    // Get active loads for today
    const [activeLoads] = await pool.execute(`
      SELECT 
          l.load_id, 
          a.tail_number,
          a.slots, 
          CONCAT(p.first_name, ' ', p.last_name) AS pilot_name, 
          l.takeoff_datetime, 
          l.notes 
      FROM loads l
      JOIN airplanes a ON l.airplane_id = a.airplane_id
      JOIN pilots p ON l.pilot_id = p.pilot_id
      WHERE l.status = 1 
        AND l.takeoff_datetime >= ? 
        AND l.takeoff_datetime <= ?
      ORDER BY l.takeoff_datetime ASC
    `, [todayStart, todayEnd]);

    // Fetch funjumpers and tandems for each active load
    for (const load of activeLoads) {
      const [funjumpers] = await pool.execute(`
        SELECT 
          j.jump_id, 
          f.funjumper_id, 
          f.first_name, 
          f.last_name AS funjumper_name, 
          f.canopy_size, 
          f.jump_ticket_balance, 
          j.group_id, 
          j.notes, 
          jt.height_feet 
        FROM 
          jumps j
        JOIN 
          fun_jumpers f ON j.funjumper_id = f.funjumper_id
        JOIN 
          jump_types jt ON j.jump_type_id = jt.jump_type_id
        WHERE 
          j.load_id = ?
      `, [load.load_id]);

      const [tandems] = await pool.execute(`
        SELECT t.tandem_id FROM tandems t
        JOIN jumps j ON t.tandem_id = j.tandem_id
        WHERE j.load_id = ?
      `, [load.load_id]);

      load.funjumpers = funjumpers;
      load.tandems = tandems;
      load.usedSlots = funjumpers.length + (tandems.length * 2); 
    }

    // Get inactive loads for today
    const [inactiveLoads] = await pool.execute(`
      SELECT 
          l.load_id, 
          a.tail_number,
          a.slots, 
          CONCAT(p.first_name, ' ', p.last_name) AS pilot_name, 
          l.takeoff_datetime, 
          l.notes 
      FROM loads l
      JOIN airplanes a ON l.airplane_id = a.airplane_id
      JOIN pilots p ON l.pilot_id = p.pilot_id
      WHERE l.status != 1 
        AND l.takeoff_datetime >= ? 
        AND l.takeoff_datetime <= ?
      ORDER BY l.takeoff_datetime ASC
    `, [todayStart, todayEnd]);

    // Fetch funjumpers and tandems for each inactive load
    for (const load of inactiveLoads) {
      const [funjumpers] = await pool.execute(`
        SELECT 
          j.jump_id, 
          f.funjumper_id, 
          f.first_name, 
          f.last_name AS funjumper_name, 
          f.canopy_size, 
          f.jump_ticket_balance, 
          j.group_id, 
          j.notes, 
          jt.height_feet 
        FROM 
          jumps j
        JOIN 
          fun_jumpers f ON j.funjumper_id = f.funjumper_id
        JOIN 
          jump_types jt ON j.jump_type_id = jt.jump_type_id
        WHERE 
          j.load_id = ?
      `, [load.load_id]);

      const [tandems] = await pool.execute(`
        SELECT t.tandem_id FROM tandems t
        JOIN jumps j ON t.tandem_id = j.tandem_id
        WHERE j.load_id = ?
      `, [load.load_id]);

      load.funjumpers = funjumpers;
      load.tandems = tandems;
      load.usedSlots = funjumpers.length + (tandems.length * 2);
    }

    return res.render('index', { 
      title: 'Operation - Manifest',
      page: 'operation-manifest',
      menuItems: menuItems,
      errors: '',
      user: req.session.user,
      activeLoads: activeLoads, 
      inactiveLoads: inactiveLoads
    });
    
  } catch (error) {
    console.error('Error registering Manifest:', error);
    req.flash('error', 'An error occurred while rendering manifest (database access).');
    return res.render('index', { 
      title: 'Operation - Manifest',
      page: 'operation-manifest',
      menuItems: menuItems,
      errors: ['Error on getting information from Database, related to manifest  (database access)'],
      user: req.session.user
    });
  }
});
app.get('/transactions/new', isLoggedIn, hasRoleLevel(5), async (req, res) => {
  return res.render('index', { 
    title: 'New Transaction',
    page: 'new-transaction',
    menuItems: menuItems,
    errors: '',
    success: '',
    user: req.session.user
  });
});
app.get('/operation/loads-dashboard', async (req, res) => {
  try {

    // 1. Get all loads
    const [allLoads] = await pool.execute('SELECT * FROM loads WHERE status = 1 AND DATE(takeoff_datetime) = CURDATE() ORDER BY load_id DESC LIMIT 5');

    // 2. Prepare data for each column
    const columns = []; 
    for (let i = 0; i < 4; i++) { // Shows the last 4 loads
      const load = allLoads[i]; // Get a load for this column
      if (load) { 
        const [funjumpers] = await pool.execute(
          `
            SELECT 
              j.*, 
              f.first_name, 
              f.last_name,
              jt.height_feet 
            FROM 
              jumps j
            LEFT JOIN 
              fun_jumpers f ON j.funjumper_id = f.funjumper_id
            LEFT JOIN
              jump_types jt ON j.jump_type_id = jt.jump_type_id
            WHERE 
              j.load_id = ? AND j.tandem_id IS NULL AND j.funjumper_id IS NOT NULL`, 
          [load.load_id]
        );

        const [tandems] = await pool.execute(
          `SELECT 
              t.tandem_id, 
              p.first_name AS passenger_first_name, 
              p.last_name AS passenger_last_name, 
              fj.first_name AS instructor_first_name, 
              fj.last_name AS instructor_last_name,
              t.photos,
              t.videos
           FROM 
              tandems t 
            JOIN 
              passengers p ON t.passenger_id = p.passenger_id 
            LEFT JOIN 
              tandem_instructors ti ON t.tandem_instructor_id = ti.tandem_instructor_id 
            LEFT JOIN 
              fun_jumpers fj ON ti.funjumper_id = fj.funjumper_id 
            JOIN 
              jumps j ON t.tandem_id = j.tandem_id
            WHERE j.load_id = ?`,
          [load.load_id]
        );

        const jumpers = funjumpers.map(jump => ({
          ...jump,
          type: 'funjumper',
          fullName: `${jump.first_name} ${jump.last_name}`
        })).concat(tandems.map(tandem => ({
          ...tandem,
          type: 'tandem',
          passengerName: `${tandem.passenger_first_name} ${tandem.passenger_last_name}`,
          instructorName: tandem.instructor_first_name ? `${tandem.instructor_first_name} ${tandem.instructor_last_name} (Instructor)` : 'Not Assigned',
          photos: tandem.photos,
          videos: tandem.videos,
          media: (tandem.photos === 1 ? '📸' : '') + (tandem.videos === 1 ? '🎬' : '')
        })));

        const [airplane] = await pool.execute('SELECT tail_number FROM airplanes WHERE airplane_id = ?', [load.airplane_id]);
        const [pilot] = await pool.execute('SELECT first_name, last_name FROM pilots WHERE pilot_id = ?', [load.pilot_id]);
        columns.push({
          load: load,
          tailNumber: airplane[0].tail_number, 
          pilotName: `${pilot[0].first_name} ${pilot[0].last_name}`, 
          jumps: jumpers
        });
      } else {
        columns.push(null); // If no load, push null for this column
      }
    }

    // Fetch Weather Data (Server-Side)
    const apiKey = 'f87ee1602b43f8ea8fd9eb94945ba3ac'; // Replace with your API key
    const city = 'TORREIRA'; // Replace with your city name
    let weatherData = null;

    try {
      const weatherResponse = await axios.get(
        `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric`
      );
      weatherData = weatherResponse.data;
    } catch (weatherError) {
      console.error('Error fetching weather data:', weatherError);
    }

    // 3. Render the dashboard with the data
    res.render('operation/loads-dashboard', { 
      title: 'Loads Dashboard', 
      menuItems: menuItems, 
      user: req.session.user, 
      columns: columns,
      weather: weatherData // Pass weather data to the template
    });

    
  } catch (error) {
    console.error('Error fetching loads data:', error);
    res.status(500).send('Error loading loads dashboard.');
  }
});
//Resume of the operation of the day
app.get('/operation/resume/:date/:hash', async (req, res) => {
  const { date, hash } = req.params;

  // Validate date format (ddmmyyyy)
  if (!/^\d{8}$/.test(date)) {
    return res.status(400).send('Invalid date format.');
  }

  // Generate expected hash
  const secret = `skydive dunas ${date}`;
  const expectedHash = crypto.createHash('md5').update(secret).digest('hex');

  // Verify hash
  if (hash !== expectedHash) {
    return res.status(403).send('Invalid hash.');
  }

  try {
    // Parse date
    const day = date.substring(0, 2);
    const month = date.substring(2, 4);
    const year = date.substring(4, 8);
    const formattedDate = `${year}-${month}-${day}`; // YYYY-MM-DD for SQL

    // Fetch loads for the specified date
    const [loads] = await pool.execute(
      'SELECT load_id, pilot_id, airplane_id, takeoff_datetime, notes FROM loads WHERE DATE(takeoff_datetime) = ?',
      [formattedDate]
    );

    const loadData = [];
    let totalFunjumpers = 0;
    let totalTandems = 0;

    for (const load of loads) {
      // Fetch pilot details
      const [pilots] = await pool.execute(
        'SELECT first_name, last_name FROM pilots WHERE pilot_id = ?',
        [load.pilot_id]
      );

      // Fetch airplane details
      const [airplanes] = await pool.execute(
        'SELECT tail_number FROM airplanes WHERE airplane_id = ?',
        [load.airplane_id]
      );

      // Fetch jumps for the load
      const [funjumpers] = await pool.execute(
        `SELECT fun_jumpers.first_name, fun_jumpers.last_name, 'funjumper' as type 
         FROM jumps 
         LEFT JOIN fun_jumpers ON jumps.funjumper_id = fun_jumpers.funjumper_id 
         WHERE jumps.load_id = ? AND jumps.tandem_id IS NULL`,
        [load.load_id]
      );

      const [tandems] = await pool.execute(
        `SELECT passengers.first_name AS passenger_first_name, passengers.last_name AS passenger_last_name, 
                fun_jumpers.first_name AS instructor_first_name, fun_jumpers.last_name AS instructor_last_name, 'tandem' as type
         FROM jumps 
         JOIN tandems ON jumps.tandem_id = tandems.tandem_id
         JOIN passengers ON tandems.passenger_id = passengers.passenger_id
         LEFT JOIN tandem_instructors ON tandems.tandem_instructor_id = tandem_instructors.tandem_instructor_id
         LEFT JOIN fun_jumpers ON tandem_instructors.funjumper_id = fun_jumpers.funjumper_id
         WHERE jumps.load_id = ?`,
        [load.load_id]
      );

      totalFunjumpers += funjumpers.length;
      totalTandems += tandems.length;

      const jumps = [...funjumpers, ...tandems].filter(jump => jump.first_name || jump.passenger_first_name);

      loadData.push({
        loadId: load.load_id,
        pilotName: pilots[0] ? `${pilots[0].first_name} ${pilots[0].last_name}` : 'Unknown Pilot',
        tailNumber: airplanes[0] ? airplanes[0].tail_number : 'Unknown Airplane',
        takeoffTime: load.takeoff_datetime,
        notes: load.notes,
        jumps: jumps,
      });
    }

    // Render the resume page with load data
    res.render('index', {
      title: `Operation Resume for ${day}/${month}/${year}`,
      page: 'operation-resume',
      loadData: loadData,
      user: req.session.user,
      menuItems: menuItems,
      totalFunjumpers: totalFunjumpers,
      totalTandems: totalTandems
    });
  } catch (error) {
    console.error('Error fetching resume data:', error);
    res.status(500).send('Error loading resume.');
  }
});
// Operation - New refuel
app.get('/operation/refuel', isLoggedIn, hasRoleLevel(5), async (req, res) => {

  try {
    const [airplanes] = await pool.execute('SELECT airplane_id, tail_number FROM airplanes');
    const [fuelTypes] = await pool.execute('SELECT fuel_type_id, fuel_name FROM fuel_types');
    const [pilots] = await pool.execute('SELECT pilot_id, first_name, last_name FROM pilots');
    const [lastRefuel] = await pool.execute('SELECT airplane_id, fuel_type_id, pilot_id FROM refuels ORDER BY refuel_datetime DESC LIMIT 1');

    const lastRefuel_airplane_id = lastRefuel.length > 0 ? lastRefuel[0].airplane_id : null; 
    const lastRefuel_pilot_id = lastRefuel.length > 0 ? lastRefuel[0].pilot_id : null; 

    if(lastRefuel.length > 0) {
      const [lastRefuelAirplane] = await pool.execute('SELECT tail_number FROM airplanes WHERE airplane_id = ?', [lastRefuel_airplane_id]);
      const [lastRefuelPilot] = await pool.execute('SELECT first_name, last_name FROM pilots WHERE pilot_id = ?', [lastRefuel_pilot_id]);

      return res.render('index', { 
        title: 'Operation - Refuel',
        page: 'operation-refuel',
        menuItems: menuItems,
        errors: '',
        user: req.session.user,
        airplanes: airplanes, 
        fuelTypes: fuelTypes ,
        pilots: pilots,
        lastRefuel : lastRefuel[0],
        lastRefuelAirplane: lastRefuelAirplane[0].tail_number, 
        lastRefuelPilotFirstName : lastRefuelPilot[0].first_name,
        lastRefuelPilotLastName : lastRefuelPilot[0].last_name
    });  
    } else {
      const lastRefuelAirplane = [''];
      const lastRefuelPilot = [''];

      return res.render('index', { 
        title: 'Operation - Refuel',
        page: 'operation-refuel',
        menuItems: menuItems,
        errors: '',
        user: req.session.user,
        airplanes: airplanes, 
        fuelTypes: fuelTypes ,
        pilots: pilots,
        lastRefuel : lastRefuel[0],
        lastRefuelAirplane: lastRefuelAirplane[0].tail_number, 
        lastRefuelPilotFirstName : lastRefuelPilot[0].first_name,
        lastRefuelPilotLastName : lastRefuelPilot[0].last_name
      });  
    }


    res.render('index', { 
        title: 'Operation - Refuel',
        page: 'operation-refuel',
        menuItems: menuItems,
        errors: '',
        user: req.session.user,
        airplanes: airplanes, 
        fuelTypes: fuelTypes ,
        pilots: pilots,
        lastRefuel : lastRefuel[0],
        lastRefuelAirplane: lastRefuelAirplane[0].tail_number, 
        lastRefuelPilotFirstName : lastRefuelPilot[0].first_name,
        lastRefuelPilotLastName : lastRefuelPilot[0].last_name
    });    
    } catch (error) {
      console.error('Error registering refuel:', error);
      req.flash('error', 'An error occurred while registering the refuel.');
      res.render('index', { 
        title: 'Operation - Refuel',
        page: 'operation-refuel',
        menuItems: menuItems,
        errors: ['Error on getting information from Database, related to fuel, pilot or airplane'],
        user: req.session.user,
        airplanes: [''], 
        fuelTypes: [''] ,
        lastRefuel : [''],
        lastRefuelAirplane: ['']
      });
  }
  
});
// Register New Jump Type
app.get('/register/new-jump-type', isLoggedIn, hasRoleLevel(1), (req, res) => {
  res.render('index', { 
      title: 'Register New Jump Type',
      page: 'register-new-jump-type',
      menuItems: menuItems,
      errors: '',
      user: req.session.user 
  });
});
// Register New Fuel Type
app.get('/register/new-fuel-type', isLoggedIn, hasRoleLevel(2), (req, res) => {
  res.render('index', { 
      title: 'Register New Fuel Type',
      page: 'register-new-fuel-type',
      menuItems: menuItems,
      errors: '',
      user: req.session.user 
  });
});
// Register New Airplane
app.get('/register/new-airplane', isLoggedIn, hasRoleLevel(2), async (req, res) => {

  res.render('index', { 
      title: 'Register New Airplane',
      page: 'register-new-airplane',
      menuItems: menuItems,
      errors: '',
      user: req.session.user,
      fuelTypes : await getFuelTypes()
  });
});
// Register New Pilot
app.get('/register/new-pilot', isLoggedIn, hasRoleLevel(2), (req, res) => {
  res.render('index', { 
      title: 'Register New Pilot',
      page: 'register-new-pilot',
      menuItems: menuItems,
      user: req.session.user,
      errors: ''
  });
});
// Register New User
app.get('/register/new-user', isLoggedIn, hasRoleLevel(2), (req, res) => {
  res.render('index', { 
      title: 'Register New User',
      page: 'register-new-user',
      menuItems: menuItems,
      user: req.session.user,
      errors: ''
  });
});
// Register New Funjumper
app.get('/register/new-funjumper', isLoggedIn, hasRoleLevel(2), (req, res) => {
  res.render('index', { 
      title: 'Register New Funjumper',
      page: 'register-new-funjumper',
      menuItems: menuItems,
      user: req.session.user,
      errors: ''
  });
});
// List all registered Jump Types
app.get('/lists/fuel-types', isLoggedIn, hasRoleLevel(2), async (req, res) => { 
  try {
    const [rows] = await pool.execute('SELECT * FROM fuel_types'); 
    res.render('index', { 
      title: 'List Fuel Types',
      page: 'list-fuel-types',
      menuItems: menuItems,
      user: req.session.user,
      errors: '',
      listContent: rows 
    });
  } catch (err) {
    console.error('Error fetching fuel types:', err);
    req.flash('error', 'An error occurred while fetching fuel types.'); 
    res.status(500).render('index', { 
      title: 'List Fuel Types',
      page: 'list-fuel-types',
      menuItems: menuItems,
      user: req.session.user,
      errors: ['An error occurred while fetching fuel types.'],
      listContent: ['']  
    });
  }
});
// List all registered Fuel Types
app.get('/lists/jump-types', isLoggedIn, hasRoleLevel(2), async (req, res) => { 
  try {
    const [rows] = await pool.execute('SELECT * FROM jump_types'); 
    res.render('index', { 
      title: 'List Jump Types',
      page: 'list-jump-types',
      menuItems: menuItems,
      user: req.session.user,
      errors: '',
      listContent: rows 
    });
  } catch (err) {
    console.error('Error fetching jump types:', err);
    req.flash('error', 'An error occurred while fetching jump types.'); 
    res.status(500).render('index', { 
      title: 'List Jump Types',
      page: 'list-jump-types',
      menuItems: menuItems,
      user: req.session.user,
      errors: ['An error occurred while fetching jump types.'],
      listContent: ['']  
    });
  }
});
// List all the registered airplanes
app.get('/lists/airplanes', isLoggedIn, hasRoleLevel(2), async (req, res) => { 
  try {
    const [rows] = await pool.execute('SELECT * FROM airplanes'); 
    res.render('index', { 
      title: 'List Airplanes',
      page: 'list-airplanes',
      menuItems: menuItems,
      user: req.session.user,
      errors: '',
      listContent: rows 
    });
  } catch (err) {
    console.error('Error fetching airplanes:', err);
    req.flash('error', 'An error occurred while fetching airplanes.'); 
    res.status(500).render('index', { 
      title: 'List Airplanes',
      page: 'list-airplanes',
      menuItems: menuItems,
      user: req.session.user,
      errors: ['An error occurred while fetching airplanes.'],
      listContent: ['']  
    });
  }
});
// List all the pilots
app.get('/lists/pilots', isLoggedIn, hasRoleLevel(2), async (req, res) => { 
  try {
    const [rows] = await pool.execute('SELECT * FROM pilots'); 
    res.render('index', { 
      title: 'List Pilots',
      page: 'list-pilots',
      menuItems: menuItems,
      user: req.session.user,
      errors: '',
      listContent: rows 
    });
  } catch (err) {
    console.error('Error fetching pilots:', err);
    req.flash('error', 'An error occurred while fetching pilots.'); 
    res.status(500).render('index', { 
      title: 'List Pilots',
      page: 'list-pilots',
      menuItems: menuItems,
      user: req.session.user,
      errors: ['An error occurred while fetching pilots.'],
      listContent: ['']  
    });
  }
});
// List all jumps
app.get('/lists/jumps', isLoggedIn, hasRoleLevel(2), async (req, res) => { 
  try {
    const [rows] = await pool.execute(`
      SELECT 
          j.jump_id, 
          j.load_id, 
          CONCAT(f.first_name, ' ', f.last_name) AS funjumper_name, 
          jt.height_feet, 
          j.group_id, 
          j.notes, 
          l.takeoff_datetime 
      FROM 
          jumps j
      JOIN 
          fun_jumpers f ON j.funjumper_id = f.funjumper_id
      JOIN
          loads l ON j.load_id = l.load_id
      JOIN 
          jump_types jt ON j.jump_type_id = jt.jump_type_id
      ORDER BY 
          j.jump_id DESC;
      `); 
    res.render('index', { 
      title: 'List Jumps',
      page: 'list-jumps',
      menuItems: menuItems,
      user: req.session.user,
      errors: '',
      listContent: rows 
    });
  } catch (err) {
    console.error('Error fetching jumps:', err);
    req.flash('error', 'An error occurred while fetching jumps.'); 
    res.status(500).render('index', { 
      title: 'List Jumps',
      page: 'list-jumps',
      menuItems: menuItems,
      user: req.session.user,
      errors: ['An error occurred while fetching jumps.'],
      listContent: ['']  
    });
  }
});
// List all the loads
app.get('/lists/loads', isLoggedIn, hasRoleLevel(2), async (req, res) => { 
  try {
    const [rows] = await pool.execute(`
      SELECT 
          l.load_id, 
          a.tail_number, 
          CONCAT(p.first_name, ' ', p.last_name) AS pilot_name, 
          l.takeoff_datetime, 
          CASE 
              WHEN l.status = 1 THEN 'Active' 
              ELSE 'Inactive' 
          END AS status, 
          (SELECT 
              SUM(CASE 
                  WHEN j.tandem_id IS NOT NULL THEN 2 
                  ELSE 1 
              END) 
            FROM jumps j 
            WHERE j.load_id = l.load_id
          ) AS occupancy, 
          a.slots, 
          l.notes 
      FROM 
          loads l 
      JOIN 
          pilots p ON l.pilot_id = p.pilot_id
      JOIN
          airplanes a ON l.airplane_id = a.airplane_id
      ORDER BY 
          l.takeoff_datetime DESC;`); 
    res.render('index', { 
      title: 'List Loads',
      page: 'list-loads',
      menuItems: menuItems,
      user: req.session.user,
      errors: '',
      listContent: rows 
    });
  } catch (err) {
    console.error('Error fetching loads:', err);
    req.flash('error', 'An error occurred while fetching loads.'); 
    res.status(500).render('index', { 
      title: 'List Loads',
      page: 'list-loads',
      menuItems: menuItems,
      user: req.session.user,
      errors: ['An error occurred while fetching loads.'],
      listContent: ['']  
    });
  }
});
// List all transactions
app.get('/lists/transactions', isLoggedIn, hasRoleLevel(2), async (req, res) => { 
  try { // FIXME - Not capturing or saving the information of tandem jumps, instructors and photos/videos correclty.
    const [rows] = await pool.execute(`
      SELECT 
          t.transaction_id, 
          t.transaction_datetime, 
          t.transaction_type,
          f.funjumper_id,
          p.pilot_id, 
          CONCAT(f.first_name, ' ', f.last_name) AS funjumper_name,
          CONCAT(p.first_name, ' ' , p.last_name) AS pilot_name, 
          t.amount, 
          t.notes,
          t.tandem_id,
          passengers.first_name AS passenger_first_name,
          passengers.last_name AS passenger_last_name,
          ti_fj.first_name AS instructor_first_name,
          ti_fj.last_name AS instructor_last_name
      FROM 
          transactions t
      LEFT JOIN 
          fun_jumpers f ON t.funjumper_id = f.funjumper_id
      LEFT JOIN 
          pilots p ON t.pilot_id = p.pilot_id
      LEFT JOIN
          tandems ON t.tandem_id = tandems.tandem_id
      LEFT JOIN
          passengers ON tandems.passenger_id = passengers.passenger_id
      LEFT JOIN
          tandem_instructors ti ON tandems.tandem_instructor_id = ti.tandem_instructor_id
      LEFT JOIN
          fun_jumpers ti_fj ON ti.funjumper_id = ti_fj.funjumper_id
      ORDER BY 
          t.transaction_datetime DESC;
    `);  
    res.render('index', { 
      title: 'List Transactions',
      page: 'list-transactions',
      menuItems: menuItems,
      user: req.session.user,
      errors: '',
      listContent: rows 
    });
  } catch (err) {
    console.error('Error fetching transactions:', err);
    req.flash('error', 'An error occurred while fetching transactions.'); 
    res.status(500).render('index', { 
      title: 'List Transactions',
      page: 'list-transactions',
      menuItems: menuItems,
      user: req.session.user,
      errors: ['An error occurred while fetching transactions.'],
      listContent: ['']  
    });
  }
});
// List all funjumpers
app.get('/lists/funjumpers', isLoggedIn, hasRoleLevel(2), async (req, res) => { 
  try {
    const [rows] = await pool.execute('SELECT * FROM fun_jumpers'); 
    res.render('index', { 
      title: 'List Funjumpers',
      page: 'list-funjumpers',
      menuItems: menuItems,
      user: req.session.user,
      errors: '',
      listContent: rows 
    });
  } catch (err) {
    console.error('Error fetching funjumpers:', err);
    req.flash('error', 'An error occurred while fetching funjumpers.'); 
    res.status(500).render('index', { 
      title: 'List Funjumpers',
      page: 'list-funjumpers',
      menuItems: menuItems,
      user: req.session.user,
      errors: ['An error occurred while fetching pilots.'],
      listContent: ['']  
    });
  }
});
// List all the pilots
app.get('/lists/refuels', isLoggedIn, hasRoleLevel(2), async (req, res) => { 
  try {
    
    const [refuels] = await pool.execute(`
      SELECT 
        r.refuel_id as refuel_id, 
        a.tail_number, 
        CONCAT(p.first_name, ' ', p.last_name) as pilot_name, 
        DATE(r.refuel_datetime) as refuel_date, 
        TIME(r.refuel_datetime) as refuel_hour, 
        ft.fuel_name as fuel_type_name, 
        r.fuel_quantity_liters, 
        r.price_per_liter, 
        r.cost, 
        r.added_mass 
      FROM 
        refuels r
      JOIN 
        airplanes a ON r.airplane_id = a.airplane_id
      JOIN 
        pilots p ON r.pilot_id = p.pilot_id
      JOIN 
        fuel_types ft ON r.fuel_type_id = ft.fuel_type_id
      ORDER BY r.refuel_datetime DESC 
    `);

    res.render('index', { 
      title: 'List Refuels',
      page: 'list-refuels',
      menuItems: menuItems,
      user: req.session.user,
      errors: '',
      listContent: refuels 
    });
  } catch (err) {
    console.error('Error fetching refuels:', err);
    req.flash('error', 'An error occurred while fetching refuels.'); 
    res.status(500).render('index', { 
      title: 'List Refuels',
      page: 'list-refuels',
      menuItems: menuItems,
      user: req.session.user,
      errors: ['An error occurred while fetching refuels.'],
      listContent: ['']  
    });
  }
});
// Login page (simple example)
app.get('/login', (req, res) => {
  // Basic validation (replace with your actual user authentication logic)
  if (req.session.user) { 
    req.flash('success', 'You are already logedin with some user!');
    res.redirect('/profile'); 
  } else {
    res.render('login', { 
      title: 'Login', 
      menuItems: menuItems, 
      messages: req.flash('error'),
      user: req.session.user  
  });
  }
});
app.get('/profile', isLoggedIn, (req,res) => {
  res.render('profile', {
    title: 'Profile',
    menuItems: menuItems,
    user: req.session.user
  });
});
// Logout route (simple example)
app.get('/logout', (req, res) => {

  try {
    delete req.session.user; 
    req.flash('success', 'Logged out successfully!');
    res.redirect('/login'); 
  } catch (error) {
    console.error('Error logging out:', error);
    req.flash('error', 'An error occurred during logout.');
    res.status(500).redirect('/'); 
  }
});
app.get('/funjumpers/:funjumperId', isLoggedIn, hasRoleLevel(2), async (req, res) => {
  
  // A if condition to check if the user cookies id is equal the the funjumperID
  if(req.session.user.id !== req.params.funjumperId && !hasRoleLevel(10)) {
    return res.status(403).send('You are not authorized to view this page');
    }
  
  try {
    const { funjumperId } = req.params;

    const [funjumper] = await pool.execute('SELECT * FROM fun_jumpers WHERE funjumper_id = ?', [funjumperId]);

    if (funjumper.length === 0) {
      return res.status(404).send('Funjumper not found.'); // TODO - Add here a custom webpage for this.
    }

    const [funjumper_jumps] = await pool.execute(`
      SELECT 
        j.jump_id,
        l.load_id,
        j.group_id,
        l.takeoff_datetime,
        a.tail_number,
        jt.height_feet 
      FROM 
        jumps j
      JOIN
        jump_types jt ON j.jump_type_id = jt.jump_type_id
      JOIN
        loads l ON j.load_id = l.load_id
      JOIN
        airplanes a ON l.airplane_id = a.airplane_id
      WHERE 
        funjumper_id = ?
      ORDER BY 
        jump_id DESC`
      , [funjumperId]);

    const [funjumper_transactions] = await pool.execute(`
      SELECT 
        * 
      FROM 
        transactions 
      WHERE 
        funjumper_id = ?
      ORDER BY
        transaction_id DESC`
      , [funjumperId]);

    return res.render('index', { 
      title: 'Funjumper Details',
      page: 'funjumper-details',
      menuItems: menuItems,
      user: req.session.user,
      errors: '',
      funjumper: funjumper[0],
      transactions: funjumper_transactions,
      jumps: funjumper_jumps
    });

  } catch (error) {
    console.error('Error fetching funjumper details:', error);
    res.status(500).send('Error fetching funjumper details.');
  }
});
app.get('/funjumpers/:funjumperId/edit', isLoggedIn, hasRoleLevel(2), async (req, res) => {
  try {
    const { funjumperId } = req.params;

    const [funjumper] = await pool.execute('SELECT * FROM fun_jumpers WHERE funjumper_id = ?', [funjumperId]);

    if (funjumper.length === 0) {
      return res.status(404).send('Funjumper not found');
    }

    // 1. Generate the expected hash
    const secret = `skydive dunas ${funjumperId}`;
    const expectedHash = crypto.createHash('md5').update(secret).digest('hex');
    return res.render('index', { 
      title: 'Edit Funjumper',
      page: 'edit-funjumper',
      menuItems: menuItems,
      user: req.session.user,
      errors: '',
      funjumper: funjumper[0],
      editHash: expectedHash
    });

  } catch (error) {
    console.error('Error fetching funjumper details:', error);
    return res.render('index', { 
      title: 'Edit Funjumper',
      page: 'edit-funjumper',
      menuItems: menuItems,
      user: req.session.user,
      errors: ['Error fetching funjumper details'],
      funjumper: [''],
      editHash: ''
    });
  }
});
app.get('/funjumpers/:funjumperId/edit/:hash', async (req, res) => {
  
  try {
    const { funjumperId, hash } = req.params;

  // 1. Generate the expected hash
  const secret = `skydive dunas ${funjumperId}`;
  const expectedHash = crypto.createHash('md5').update(secret).digest('hex');

  // 2. Compare the hashes
  if (hash !== expectedHash) {
    // 3. Hash mismatch - return error page
    return res.status(404).send("<h1>No authorization for this page</h1>");
  }

    const [funjumper] = await pool.execute('SELECT * FROM fun_jumpers WHERE funjumper_id = ?', [funjumperId]);

    if (funjumper.length === 0) {
      return res.status(404).send('Funjumper not found');
    }

    return res.render('index', { 
      title: 'Edit Funjumper',
      page: 'edit-funjumper',
      menuItems: menuItems,
      user: req.session.user,
      errors: '',
      funjumper: funjumper[0],
      editHash: ''
    });

  } catch (error) {
    console.error('Error fetching funjumper details:', error);
    return res.render('index', { 
      title: 'Edit Funjumper',
      page: 'edit-funjumper',
      menuItems: menuItems,
      user: req.session.user,
      errors: ['Error fetching funjumper details'],
      funjumper: [''],
      editHash: '' 
    });
  }
});

// --- TANDEM RELATED ---
// Checkin a Tandem
app.get('/tandem/checkin', isLoggedIn, hasRoleLevel(2), async (req, res) => {
  res.render('index', { 
    title: 'Tandem Checkin',
    page: 'tandem-checkin',
    menuItems: menuItems,
    user: req.session.user,
    errors: '',
    success: '' 
  });
});
app.get('/register/new-instructor', isLoggedIn, hasRoleLevel(2), async (req, res) => {
  res.render('index', { 
    title: 'Register New Instructor',
    page: 'register-new-instructor',
    menuItems: menuItems,
    user: req.session.user,
    errors: '',
    success: '' 
  });
});
// List Tandem passengers
app.get('/tandem/list-passengers', isLoggedIn, hasRoleLevel(2), async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT * FROM passengers'); 

    res.render('index', { 
    title: 'List Tandem Passengers',
    page: 'tandem-list-passengers',
    menuItems: menuItems,
    user: req.session.user,
    errors: '',
    listContent: rows
  });
  } catch (err) {
    console.error('Error fetching passengers:', err);
    req.flash('error', 'An error occurred while fetching passengers.'); 
    res.status(500).render('index', { 
      title: 'List Tandem Passengers',
      page: 'tandem-list-passengers',
      menuItems: menuItems,
      user: req.session.user,
      errors: ['An error occurred while fetching passengers.'],
      listContent: ['']  
    });
  }
});
// List all Instructos
app.get('/lists/instructors', isLoggedIn, hasRoleLevel(2), async (req, res) => { 
  try {
    
    const [refuels] = await pool.execute(`
      SELECT 
          ti.tandem_instructor_id AS tandem_instructor_id,
          fj.first_name AS first_name,
          fj.middle_names AS middle_names,
          fj.last_name AS last_name,
          fj.date_of_birth AS date_of_birth,
          fj.phone_number AS phone_number,
          ti.jump_balance AS jump_balance,
          ti.tandem_rating AS tandem_rating,
          ti.camera_rating AS camera_rating,
          fj.license_number AS license_number,
          fj.license_expire AS license_expire,
          fj.insurance_expire AS insurance_expire,
          fj.civil_id_expires AS civil_id_expires,
          fj.emergency_contact_name AS emergency_contact_name,
          fj.emergency_contact_relation AS emergency_contact_relation,
          fj.emergency_contact_phone AS emergency_contact_phone 
      FROM 
          tandem_instructors AS ti
      JOIN
          fun_jumpers AS fj ON ti.funjumper_id = fj.funjumper_id;
    `);

    res.render('index', { 
      title: 'List Instructors',
      page: 'list-instructors',
      menuItems: menuItems,
      user: req.session.user,
      errors: '',
      listContent: refuels 
    });
  } catch (err) {
    console.error('Error fetching instructors:', err);
    req.flash('error', 'An error occurred while fetching instructors.'); 
    res.status(500).render('index', { 
      title: 'List Instructors',
      page: 'list-instructors',
      menuItems: menuItems,
      user: req.session.user,
      errors: ['An error occurred while fetching instructors.'],
      listContent: ['']  
    });
  }
});



// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<[ POST ]>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

//Handles the form for register of a new pilot
app.post('/register/new-pilot', isLoggedIn, hasRoleLevel(2), 
  [
    check('first_name').notEmpty().withMessage('First Name is required'),
    check('last_name').notEmpty().withMessage('Last Name is required'),
    check('date_of_birth').notEmpty().withMessage('Date of Birth is required'),
    check('date_of_birth').isDate().withMessage('Invalid Date of Birth'),
    check('email').notEmpty().withMessage('E-mail is required'),
    check('email').isEmail().withMessage('Invalid Email address'),
    check('phone_number').notEmpty().withMessage('Phone Number is required'),
    check('phone_number').isMobilePhone().withMessage('Invalid Phone Number'),
    check('ratings').notEmpty().withMessage('Ratings is required'),
    check('license_number').notEmpty().withMessage('License Number is required'),
    check('license_expiration_date').notEmpty().withMessage('License Expiration Date is required'),
    check('license_expiration_date').isDate().withMessage('Invalid License Expiration Date'),
    check('medical_expiration_date').notEmpty().withMessage('Medical Expiration Data is required'),
    check('medical_expiration_date').isDate().withMessage('Invalid Medical Expiration Date'),
    check('local_hours').isFloat({min:0}).withMessage('Local Hours must be a non-negative number'),
    check('landings').isFloat({min:0}).withMessage('Landings Number must be a non-negative number'),
    check('total_hours').notEmpty().withMessage('Total Hours is required'),
    check('total_hours').isFloat({min:0}).withMessage('Total Hours must be a non-negative number'),
    check('emergency_contact_name').notEmpty().withMessage('Emergency Contact Name is required'),
    check('emergency_contact_phone').notEmpty().withMessage('Emergency Contact Phone is required'),
    check('emergency_contact_phone').isMobilePhone().withMessage('Invalid Emergency Contact Phone number'),
    check('emergency_contact_relation').notEmpty().withMessage('Emergency Contact Relation is required'),
    check('emergency_contact_email').notEmpty().withMessage('Emergency Contact Email is required'),
    check('emergency_contact_email').isEmail().withMessage('Invalid Emergency Contact Email'),
    check('pay_per_load').notEmpty().withMessage('Pay per Load is required'),
    check('pay_per_load').isFloat({min:0}).withMessage('Pay per Load must be a non-negative number'),
    // Add more validation rules as needed 
    // e.g., 
    // check('dateOfBirth').notEmpty().withMessage('Date of Birth is required'), 
    // check('email').isEmail().withMessage('Invalid email address') 
  ],
  async (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      // Handle validation errors
      const alertMessages = errors.array().map(error => error.msg);
      req.flash('error', alertMessages); 
      return res.status(400).render('index', { 
        title: 'Register New Pilot', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'register-new-pilot',
        errors: alertMessages 
      });
    }

    // If validation passes, proceed to save data to the database
    const { first_name, middle_names, last_name, license_number, license_expiration_date, medical_expiration_date,
          local_hours, phone_number, email, total_hours, ratings, landings, emergency_contact_name, emergency_contact_relation, 
          emergency_contact_phone, emergency_contact_email, pay_per_load, date_of_birth
     } = req.body;

    try {

      const formatted_license_expiration_date = license_expiration_date ? moment(license_expiration_date, 'YYYY-MM-DD').format('YYYY-MM-DD') : null;
      const formatted_medical_expiration_date = medical_expiration_date ? moment(medical_expiration_date, 'YYYY-MM-DD').format('YYYY-MM-DD') : null;
      const formatted_date_of_birth = date_of_birth ? moment(date_of_birth, 'YYYY-MM-DD').format('YYYY-MM-DD') : null;

      // Insert data into the database using prepared statement
      const [result] = await pool.execute('INSERT INTO pilots \
        (first_name, middle_names, last_name, license_number, license_expiration_date, medical_expiration_date, \
         local_hours, phone_number, email, total_hours, ratings, landings, emergency_contact_name, emergency_contact_relation, \
         emergency_contact_phone, emergency_contact_email, pay_per_load, date_of_birth) \
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
        [first_name, middle_names, last_name, license_number, formatted_license_expiration_date, formatted_medical_expiration_date,
         local_hours, phone_number, email, total_hours, ratings, landings, emergency_contact_name, emergency_contact_relation, 
         emergency_contact_phone, emergency_contact_email, pay_per_load, formatted_date_of_birth]);

      
      console.log('New pilot created with ID:', result.insertId);
      req.flash('success', 'New Pilot registered successfully!');
      res.redirect('/');

    } catch (err) {
      console.error('Error inserting pilot:', err);
      req.flash('error', 'An error occurred. Please try again.');
      return res.status(400).render('index', { 
        title: 'Register New Pilot', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'register-new-pilot',
        errors: ['Database error inserting pilot.'] 
      });
    }
  }
);
//Handles the form for register of a new funjumper
app.post('/register/new-funjumper', isLoggedIn, hasRoleLevel(2),
  [
    // Personal Information
    check('first_name').notEmpty().withMessage('First Name is required'),
    check('last_name').notEmpty().withMessage('Last Name is required'),
    check('date_of_birth').notEmpty().withMessage('Date of Birth is required'),
    check('date_of_birth').custom((value) => {
      const birthdate = moment(value, 'YYYY-MM-DD');
      return birthdate.isValid() && birthdate.isBefore(moment());}).withMessage('Date of Birth must be a valid date in the past'),
    check('nationality').notEmpty().withMessage('Nationality is required'),
    check('civil_id_number').notEmpty().withMessage('Passport/ID Number is required'),
    check('civil_id_expires').notEmpty().withMessage('Passport/ID Number Expire Date is required'),
    check('civil_id_expires').isDate().withMessage('Invalid Passport/ID Number Expire Date'),
    //Contact Information
    check('phone_number').notEmpty().withMessage('Phone Number is required'),
    check('phone_number').isMobilePhone().withMessage('Invalid Mobile Phone'),
    check('email').notEmpty().withMessage('Email is required'),
    check('email').isEmail().withMessage('Invalid Email Address'),
    check('street_address').notEmpty().withMessage('Street Address is required'),
    check('city_address').notEmpty().withMessage('City is required'),
    check('postal_code').notEmpty().withMessage('Postal Code is required'),
    check('postal_code').isPostalCode('PT').withMessage('Invalid Postal Code'),
    check('country').notEmpty().withMessage('Country is required'),
    //License and Insurance Information
    check('number_of_jumps').notEmpty().withMessage('Number of Jumps is required'),
    check('number_of_jumps').isInt({min : 0}).withMessage('Number of Jumps must be a non-negative integer'),
    check('license_issuer').notEmpty().withMessage('License Issuer is required'),
    check('license_letter').notEmpty().withMessage('License Letter is required'),
    check('license_number').notEmpty().withMessage('License Number is required'),
    check('license_number').isInt({min : 0}).withMessage('License Number must be a non-negative number'),
    check('license_expire').notEmpty().withMessage('License Expire Date is required'),
    check('license_expire').isDate().withMessage('Invalid License Expire Date'),
    check('insurance_issuer').notEmpty().withMessage('Insurance Issuer is required'),
    check('insurance_number').notEmpty().withMessage('Insurance Number is required'),
    check('insurance_expire').notEmpty().withMessage('Insurance Expire Date is required'),
    check('insurance_expire').isDate().withMessage('Invalid Insurance Expire Date'),
    // Emergency Contact Information
    check('emergency_contact_name').notEmpty().withMessage('Emergency Contact Name is required'),
    check('emergency_contact_relation').notEmpty().withMessage('Emergency Contact Relation is required'),
    check('emergency_contact_phone').notEmpty().withMessage('Emergency Contact Phone is required'),
    check('emergency_contact_phone').isMobilePhone().withMessage('Invalid Contact Phone Number'),
    //check('emergency_contact_email').notEmpty().withMessage('Emergency Contact Email is required'),
    //check('emergency_contact_email').isEmail().withMessage('Invalid Emergency Contact Email'),
  ],
  async (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      // Handle validation errors
      const alertMessages = errors.array().map(error => error.msg);
      req.flash('error', alertMessages); 
      return res.status(400).render('index', { 
        title: 'Register New Funjumper', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'register-new-funjumper',
        errors: alertMessages 
      });
    }

    // If validation passes, proceed to save data to the database
    const { first_name, middle_names, last_name, license_letter, license_number, license_issuer, license_expire, emergency_contact_name, 
      emergency_contact_relation, emergency_contact_phone, emergency_contact_email, insurance_number, insurance_issuer, insurance_expire, 
      insurance_number_health, insurance_issuer_health, insurance_expire_health, phone_number, canopy_size, canopy_brand_type, container_manufaturer, 
      reserve_brand, reserve_size, repack_duedate, number_of_jumps, civil_id_number, civil_id_expires, date_of_birth, nationality,
      email, street_address, city_address, postal_code, country } = req.body;

    try {

      let formatted_insurance_expire_health = null;
      if (insurance_expire_health) { 
        formatted_insurance_expire_health = insurance_expire_health; 
      }
      let formatted_repack_duedate = null;
      if (repack_duedate) { 
        formatted_repack_duedate = repack_duedate; 
      }
      let formatted_canopy_size = null;
      if (canopy_size) { 
        formatted_canopy_size = canopy_size; 
      }
      let formatted_reserve_size = null;
      if (reserve_size) { 
        formatted_reserve_size = reserve_size; 
      }
      const now_date = moment.utc().format('YYYY-MM-DD HH:mm:ss'); // Get current datetime in UTC

      // Insert data into the database using prepared statement
      const [result] = await pool.execute('INSERT INTO fun_jumpers \
        (first_name, middle_names, last_name, license_letter, license_number, license_issuer, license_expire, emergency_contact_name, \
        emergency_contact_relation, emergency_contact_phone, emergency_contact_email, insurance_number, insurance_issuer, insurance_expire, \
        insurance_number_health, insurance_issuer_health, insurance_expire_health, phone_number, canopy_size, canopy_brand_type, container_manufaturer, \
        reserve_brand, reserve_size, repack_duedate, number_of_jumps, civil_id_number, civil_id_expires, date_of_birth, nationality, \
        email, create_time, street_address, city_address, postal_code, country) \
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
        [first_name, middle_names, last_name, license_letter, license_number, license_issuer, license_expire, emergency_contact_name, 
        emergency_contact_relation, emergency_contact_phone, emergency_contact_email, insurance_number, insurance_issuer, insurance_expire, 
        insurance_number_health, insurance_issuer_health, formatted_insurance_expire_health, phone_number, formatted_canopy_size, canopy_brand_type, container_manufaturer, 
        reserve_brand, formatted_reserve_size, formatted_repack_duedate, number_of_jumps, civil_id_number, civil_id_expires, date_of_birth, nationality,
        email, now_date, street_address, city_address, postal_code, country]);
      
      console.log('New funjumper created with ID:', result.insertId);
      req.flash('success', 'New Funjumper registered successfully!');
      res.redirect('/');

    } catch (err) {
      console.error('Error inserting funjumper:', err);
      req.flash('error', 'An error occurred. Please try again.');
      return res.status(400).render('index', { 
        title: 'Register New Funjumper', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'register-new-funjumper',
        errors: ['Database error inserting airplane.'] 
      });
    }
  }
);
// Updates the information related to a funjumper
// FIXME - Set authentication required for this
app.post('/funjumpers/:funjumperId/update', /* isLoggedIn, hasRoleLevel(2), */
  [
    // Personal Information
    check('first_name').notEmpty().withMessage('First Name is required'),
    check('last_name').notEmpty().withMessage('Last Name is required'),
    check('date_of_birth').notEmpty().withMessage('Date of Birth is required'),
    check('date_of_birth').custom((value) => {
      const birthdate = moment(value, 'YYYY-MM-DD');
      return birthdate.isValid() && birthdate.isBefore(moment());}).withMessage('Date of Birth must be a valid date in the past'),
    check('nationality').notEmpty().withMessage('Nationality is required'),
    check('civil_id_number').notEmpty().withMessage('Passport/ID Number is required'),
    check('civil_id_expires').notEmpty().withMessage('Passport/ID Number Expire Date is required'),
    check('civil_id_expires').isDate().withMessage('Invalid Passport/ID Number Expire Date'),
    //Contact Information
    check('phone_number').notEmpty().withMessage('Phone Number is required'),
    check('phone_number').isMobilePhone().withMessage('Invalid Mobile Phone'),
    check('email').notEmpty().withMessage('Email is required'),
    check('email').isEmail().withMessage('Invalid Email Address'),
    check('street_address').notEmpty().withMessage('Street Address is required'),
    check('city_address').notEmpty().withMessage('City is required'),
    check('postal_code').notEmpty().withMessage('Postal Code is required'),
    check('postal_code').isPostalCode('PT').withMessage('Invalid Postal Code'),
    check('country').notEmpty().withMessage('Country is required'),
    //License and Insurance Information
    check('number_of_jumps').notEmpty().withMessage('Number of Jumps is required'),
    check('number_of_jumps').isInt({min : 0}).withMessage('Number of Jumps must be a non-negative integer'),
    check('license_issuer').notEmpty().withMessage('License Issuer is required'),
    check('license_letter').notEmpty().withMessage('License Letter is required'),
    check('license_number').notEmpty().withMessage('License Number is required'),
    check('license_number').isInt({min : 0}).withMessage('License Number must be a non-negative number'),
    check('license_expire').notEmpty().withMessage('License Expire Date is required'),
    check('license_expire').isDate().withMessage('Invalid License Expire Date'),
    check('insurance_issuer').notEmpty().withMessage('Insurance Issuer is required'),
    check('insurance_number').notEmpty().withMessage('Insurance Number is required'),
    check('insurance_expire').notEmpty().withMessage('Insurance Expire Date is required'),
    check('insurance_expire').isDate().withMessage('Invalid Insurance Expire Date'),
    // Emergency Contact Information
    check('emergency_contact_name').notEmpty().withMessage('Emergency Contact Name is required'),
    check('emergency_contact_relation').notEmpty().withMessage('Emergency Contact Relation is required'),
    check('emergency_contact_phone').notEmpty().withMessage('Emergency Contact Phone is required'),
    check('emergency_contact_phone').isMobilePhone().withMessage('Invalid Contact Phone Number'),
    //check('emergency_contact_email').notEmpty().withMessage('Emergency Contact Email is required'),
    //check('emergency_contact_email').isEmail().withMessage('Invalid Emergency Contact Email'),
  ],
  async (req, res) => {

    const errors = validationResult(req);
    const { funjumperId } = req.params;

    if (!errors.isEmpty()) {
      // Handle validation errors
      const [funjumper] = await pool.execute('SELECT * FROM fun_jumpers WHERE funjumper_id = ?', [funjumperId]);
      const alertMessages = errors.array().map(error => error.msg);
      req.flash('error', alertMessages); 
      return res.render('index', { 
        title: 'Edit Funjumper',
        page: 'edit-funjumper',
        menuItems: menuItems,
        user: req.session.user,
        errors: alertMessages,
        funjumper: funjumper[0]
      });
    }

  try {
    const { 
      first_name, middle_names, last_name, date_of_birth, nationality, 
      email, phone_number, number_of_jumps, waiver_signed, civil_id_number, civil_id_expires, 
      street_address, city_address, postal_code, country, 
      license_issuer, license_letter, license_number, license_expire, 
      insurance_issuer, insurance_number, insurance_expire, 
      insurance_issuer_health, insurance_number_health, insurance_expire_health, 
      emergency_contact_name, emergency_contact_relation, emergency_contact_phone, emergency_contact_email, 
      canopy_brand_type, canopy_size, container_manufaturer, reserve_brand, reserve_size, repack_duedate 
    } = req.body;

    // Handle potential null values for all optional fields
    const formattedMiddleNames = middle_names || null; 
    const formattedInsuranceIssuerHealth = insurance_issuer_health || null;
    const formattedInsuranceNumberHealth = insurance_number_health || null;
    const formattedInsuranceExpireHealth = insurance_expire_health || null;
    const formattedContainerManufacturer = container_manufaturer || null; 
    const formattedCanopyBrandType = canopy_brand_type || null; 
    const formattedCanopySize = canopy_size || null; 
    const formattedReserveBrand = reserve_brand || null; 
    const formattedReserveSize = reserve_size || null; 
    const formattedRepackDueDate = repack_duedate || null; 
    const formattedWaiverSigned = waiver_signed === 'true' ? 1 : 0;

    const [result] = await pool.execute(
      `UPDATE fun_jumpers 
       SET 
         first_name = ?, 
         middle_names = ?, 
         last_name = ?, 
         date_of_birth = ?, 
         nationality = ?, 
         email = ?, 
         phone_number = ?, 
         number_of_jumps = ?, 
         waiver_signed = ?, 
         civil_id_number = ?, 
         civil_id_expires = ?, 
         street_address = ?, 
         city_address = ?, 
         postal_code = ?, 
         country = ?, 
         license_issuer = ?, 
         license_letter = ?, 
         license_number = ?, 
         license_expire = ?, 
         insurance_issuer = ?, 
         insurance_number = ?, 
         insurance_expire = ?, 
         insurance_issuer_health = ?, 
         insurance_number_health = ?, 
         insurance_expire_health = ?, 
         emergency_contact_name = ?, 
         emergency_contact_relation = ?, 
         emergency_contact_phone = ?, 
         emergency_contact_email = ?, 
         canopy_brand_type = ?, 
         canopy_size = ?, 
         container_manufaturer = ?, 
         reserve_brand = ?, 
         reserve_size = ?, 
         repack_duedate = ? 
       WHERE funjumper_id = ?`, 
      [
        first_name, formattedMiddleNames, last_name, date_of_birth, nationality, 
        email, phone_number, number_of_jumps, formattedWaiverSigned, civil_id_number, civil_id_expires, 
        street_address, city_address, postal_code, country, 
        license_issuer, license_letter, license_number, license_expire, 
        insurance_issuer, insurance_number, insurance_expire, 
        formattedInsuranceIssuerHealth, formattedInsuranceNumberHealth, formattedInsuranceExpireHealth, 
        emergency_contact_name, emergency_contact_relation, emergency_contact_phone, emergency_contact_email, 
        formattedCanopyBrandType, formattedCanopySize, formattedContainerManufacturer, formattedReserveBrand, formattedReserveSize, formattedRepackDueDate, 
        funjumperId 
      ]
    );

    return res.redirect(`/funjumpers/${funjumperId}`); // Redirect to the updated funjumper details page

  } catch (error) {
    console.error('Error updating funjumper:', error);
    res.status(500).send('Error updating funjumper');
  }
});
//Handles the form for register of a Airplane
app.post('/register/new-airplane', isLoggedIn, hasRoleLevel(2), 
  [
    check('tail_number').notEmpty().withMessage('Tail Number is required'),
    check('serial_number').notEmpty().withMessage('Serial Number is required'),
    check('aircraft_type').notEmpty().withMessage('Airplane Type is required'),
    check('max_passengers').notEmpty().withMessage('Max Passengers is required'),
    check('max_passengers').isInt({min : 0}).withMessage('Max Passengers needs to be a non-negative number'),
    check('slots').notEmpty().withMessage('Number of Available Slots is required'),
    check('slots').isInt({min : 0}).withMessage('Slots needs to be a non-negative integer number'),
    check('flight_hours').notEmpty().withMessage('Fligth Hours is required'),
    check('flight_hours').isInt({min : 0}).withMessage('Fligth Hours needs to be a non-negative integer number'),
    check('last_maintenance').notEmpty().withMessage('Last Maintenance Date is required'),
    check('maintenance_interval').notEmpty().withMessage('Maintenance interval (hrs) is required'),
    check('maintenance_interval').isInt({min : 0}).withMessage('Maintenance Interval needs to be a non-negative integer number'),
    check('rating').notEmpty().withMessage('Ratings for this Airplane is required'),
    check('engine_type').notEmpty().withMessage('Engine Type is required'),
    check('fuel_type').notEmpty().withMessage('Fuel Type is required'),
    //check('fuel_type').isIn(fuelTypes).withMessage('Invalid Fuel Type')
  ],
  async (req, res) => {

    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      // Handle validation errors
      const alertMessages = errors.array().map(error => error.msg);
      req.flash('error', alertMessages); 
      return res.status(400).render('index', { 
        title: 'Register New Airplane', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'register-new-airplane',
        errors: alertMessages, 
        fuelTypes : await getFuelTypes()
      });
    }

    // If validation passes, proceed to save data to the database
    const { tail_number, serial_number, aircraft_type, max_passengers, slots, flight_hours, 
      last_maintenance, maintenance_interval, rating, engine_type, fuel_type
    } = req.body;

    try {
          // Get fuel_type_id 
          const [fuelTypeResult] = await pool.execute('SELECT fuel_type_id FROM fuel_types WHERE fuel_name = ?', [fuel_type]);
          const fuel_type_id = fuelTypeResult[0].fuel_type_id; 

          if (fuel_type_id.length === 0) {
            req.flash('error', 'Invalid Fuel Type selected.');
            return res.status(400).res.render('index', { 
              title: 'Register New Airplane',
              page: 'register-new-airplane',
              menuItems: menuItems,
              errors: ['Invalid Fuel Name selected - Not existent on Database.'],
              user: req.session.user, 
              fuelTypes : await getFuelTypes()
          });
        }
    } catch (err) {
          console.error('Error getting Airplane Fuel ID from database:', err);
          req.flash('error', 'An error occurred. Please try again.');
          return res.render('index', { 
              title: 'Register New Airplane',
              page: 'register-new-airplane',
              menuItems: menuItems,
              errors: ['Database error getting fuel_id.'],
              user: req.session.user, 
              fuelTypes : await getFuelTypes()
          });
      }

    try {
      // Get fuel_type_id 
      const [fuelTypeResult] = await pool.execute('SELECT fuel_type_id FROM fuel_types WHERE fuel_name = ?', [fuel_type]);
      const fuel_type_id = fuelTypeResult[0].fuel_type_id; 

      // Insert data into the database using prepared statement
      const [result] = await pool.execute('INSERT INTO airplanes (tail_number, serial_number, aircraft_type, max_passengers, slots, flight_hours, last_maintenance, maintenance_interval, rating, engine_type, fuel_type_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', 
        [tail_number, serial_number, aircraft_type, max_passengers, slots, flight_hours, last_maintenance, maintenance_interval, rating, engine_type, fuel_type_id]);
      
      console.log('New airplane created with ID:', result.insertId);
      req.flash('success', 'New Fuel Type registered successfully!');
      res.redirect('/');

    } catch (err) {
      console.error('Error inserting airplane:', err);
      req.flash('error', 'An error occurred. Please try again.');
      return res.render('index', { 
          title: 'Register New Airplane',
          page: 'register-new-airplane',
          menuItems: menuItems,
          errors: ['Database error inserting airplane.'],
          user: req.session.user, 
          fuelTypes : await getFuelTypes()
      });
    }
  }
);
//Handles the form for register of a fuel type
app.post('/register/new-fuel-type', isLoggedIn, hasRoleLevel(2), 
  [
    check('fuel_name').notEmpty().withMessage('First Name is required'),
    check('density').notEmpty().withMessage('Last Name is required'),
    check('density').isFloat({min:0}).withMessage('Density must be a non-negative number'),
    check('price_per_liter').notEmpty().withMessage('Date of Birth is required'),
    check('price_per_liter').isFloat({min:0}).withMessage('Price per Liter must be a non-negative number')
    // Add more validation rules as needed 
    // e.g., 
    // check('dateOfBirth').notEmpty().withMessage('Date of Birth is required'), 
    // check('email').isEmail().withMessage('Invalid email address') 
  ],
  async (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      // Handle validation errors
      const alertMessages = errors.array().map(error => error.msg);
      req.flash('error', alertMessages); 
      return res.status(400).render('index', { 
        title: 'Register New Fuel Type', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'register-new-fuel-type',
        errors: alertMessages 
      });
    }
    // If validation passes, proceed to save data to the database
    const { fuel_name, density, price_per_liter } = req.body;

    try {
      // Insert data into the database using prepared statement
      const [result] = await pool.execute('INSERT INTO fuel_types (fuel_name, density, price_per_liter) VALUES (?, ?, ?)', [fuel_name, density, price_per_liter]);
      
      console.log('New fuel type created with ID:', result.insertId);
      req.flash('success', 'New Fuel Type registered successfully!');
      res.redirect('/');

    } catch (err) {
      console.error('Error inserting fuel type:', err);
      req.flash('error', 'An error occurred. Please try again.');
      return res.render('index', { 
          title: 'Register New Fuel Type',
          page: 'register-new-fuel-type',
          menuItems: menuItems,
          errors: ['Database error inserting fuel type.'],
          user: req.session.user 
      });
    }
  }
);
//Handles the form for register of a fuel type
app.post('/register/new-jump-type', isLoggedIn, hasRoleLevel(2), 
  [
    check('jump_name').notEmpty().withMessage('Jump Name (description) is required'),
    check('height_feet').notEmpty().withMessage('Exit Heigh is required'),
    check('height_feet').isInt({min:0}).withMessage('Exit Heigh must be a non-negative integer number'),
  ],
  async (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      // Handle validation errors
      const alertMessages = errors.array().map(error => error.msg);
      req.flash('error', alertMessages); 
      return res.status(400).render('index', { 
        title: 'Register New Jump Type', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'register-new-jump-type',
        errors: alertMessages 
      });
    }
    // If validation passes, proceed to save data to the database
    const { jump_name, height_feet } = req.body;

    try {
      // Insert data into the database using prepared statement
      const [result] = await pool.execute('INSERT INTO jump_types (jump_name, height_feet) VALUES (?, ?)', [jump_name, height_feet]);
      
      console.log('New jump type created with ID:', result.insertId);
      req.flash('success', 'New Jump Type registered successfully!');
      res.redirect('/');

    } catch (err) {
      console.error('Error inserting jump type:', err);
      req.flash('error', 'An error occurred. Please try again.');
      return res.render('index', { 
          title: 'Register New Jump Type',
          page: 'register-new-jump-type',
          menuItems: menuItems,
          errors: ['Database error inserting jump type.'],
          user: req.session.user 
      });
    }
  }
);
// Handle the login form
app.post('/login', async (req, res) => {

  /* const { username, password } = req.body;
  // Basic validation (replace with your actual user authentication logic)
  if (username === 'admin' && password === '12345') { 
    req.session.user = { id: 4, username: 'admin', rolelevel : 1 }; 
    req.flash('success', 'Login successful!');
    res.redirect('/'); 
  } else {
    res.render('login', { 
      title: 'Login', 
      menuItems: menuItems, 
      messages: req.flash('error'),
      user: req.session.user  
  }); */

  const { username, password } = req.body;

  try {
      // 2. Find user by username
      const [rows] = await pool.query('SELECT * FROM users WHERE username = ?', [username]);
      const user = rows[0];

      // 3. Check if user exists
      if (!user) {
        req.flash('error', 'Invalid username or password');
        return res.render('login', {
          title: 'Login',
          menuItems: menuItems,
          messages: req.flash('error'),
          user: req.session.user,
        });
      }

      // 4. Compare password hash (using bcrypt)
      const isPasswordValid = await bcrypt.compare(password, user.password_hash);

      const saltRounds = 10; // Adjust as needed
      const hashedPassword = await bcrypt.hash(password, saltRounds);
      console.log(hashedPassword);

      if (!isPasswordValid) {
        req.flash('error', 'Invalid username or password');
        return res.render('login', {
          title: 'Login',
          menuItems: menuItems,
          messages: req.flash('error'),
          user: req.session.user,
        });
      }

      // 5. Login successful - store user info in session (excluding password hash)
      req.session.user = {
        id: user.user_id,
        username: user.username,
        rolelevel: user.rolelevel,
        email: user.email,
        funjumper_id: user.funjumper_id,
      };
      req.flash('success', 'Login successful!');
      res.redirect('/');
    } catch (error) {
      console.error('Error logging in user:', error);
      req.flash('error', 'An error occurred during login. Please try again.');
      res.render('login', {
        title: 'Login',
        menuItems: menuItems,
        messages: req.flash('error'),
        user: req.session.user,
      });
  }

});
//Handles the form for register of a new user
app.post('/register/new-user', isLoggedIn, hasRoleLevel(2), 
  [
    check('username').notEmpty().withMessage('First Name is required'),
    check('email').notEmpty().withMessage('E-mail is required'),
    check('email').isEmail().withMessage('Invalid Email address'),
    check('password').notEmpty().withMessage('Password is required'),
    check('password').isLength({min: 6}).withMessage('Password must be at least 6 characters long'),
    check('2password').notEmpty().withMessage('Password is required'),
    check('2password').isLength({min: 6}).withMessage('Password must be at least 6 characters long'),
    check('2password').custom((value, { req }) => {
      if (value !== req.body.password) {
          return false;
      }
      return true;}).withMessage('Passwords do not match'),
    check('rolelevel').notEmpty().withMessage('Role Level is required'),
    check('rolelevel').isInt({min:0}).withMessage('Role Level must be a non-negative integer')
  ],
  async (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      // Handle validation errors
      const alertMessages = errors.array().map(error => error.msg);
      req.flash('error', alertMessages); 
      return res.status(400).render('index', { 
        title: 'Register New User', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'register-new-user',
        errors: alertMessages 
      });
    }

    // If validation passes, proceed to save data to the database
    const { username, password, rolelevel, email } = req.body;

    try {

      // Hash the password
      const saltRounds = 10; // Adjust as needed
      const hashedPassword = await bcrypt.hash(password, saltRounds);

      // Insert data into the database using prepared statement
      const [result] = await pool.execute('INSERT INTO users \
        (username, password_hash, rolelevel, email, funjumper_id, pilot_id) \
        VALUES (?, ?, ?, ?, NULL, NULL)', 
        [username, hashedPassword, rolelevel, email]);

      
      console.log('New user created with ID:', result.insertId);
      req.flash('success', 'New User registered successfully!');
      res.redirect('/');

    } catch (err) {
      console.error('Error inserting user:', err);
      req.flash('error', 'An error occurred. Please try again.');
      return res.status(400).render('index', { 
        title: 'Register New User', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'register-new-user',
        errors: ['Database error inserting user.'] 
      });
    }
  }
);
app.post('/operation/refuel', isLoggedIn, hasRoleLevel(2), 
  [
    check('airplane_id').notEmpty().withMessage('Jump Name (description) is required'),
    check('airplane_id').isInt({min:0}).withMessage('Invalid Airplane ID'),
    check('fuel_type_name').notEmpty().withMessage('Jump Name (description) is required'),
    check('pilot_id').notEmpty().withMessage('Jump Name (description) is required'),
    check('pilot_id').isInt({min:0}).withMessage('Invalid Pilot ID'),
    check('fuel_quantity_liters').notEmpty().withMessage('Jump Name (description) is required'),
    check('fuel_quantity_liters').isFloat({min:1}).withMessage('You must add at least 1 Liter of Fuel.'),
    check('cost').notEmpty().withMessage('Jump Name (description) is required'),
    check('cost').isFloat({min:1}).withMessage('You must add at least 1 Euro of Fuel.'),
    check('added_mass').notEmpty().withMessage('Jump Name (description) is required'),
    check('added_mass').isFloat({min:0}).withMessage('Invalid Added Mass to the airplane.'),
  ],
  async (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      // Handle validation errors
      const alertMessages = errors.array().map(error => error.msg);
      req.flash('error', alertMessages); 
      try {
        const [airplanes] = await pool.execute('SELECT airplane_id, tail_number FROM airplanes');
        const [fuelTypes] = await pool.execute('SELECT fuel_type_id, fuel_name FROM fuel_types');
        const [pilots] = await pool.execute('SELECT pilot_id, first_name, last_name FROM pilots');
        const [lastRefuel] = await pool.execute('SELECT airplane_id, fuel_type_id, pilot_id FROM refuels ORDER BY refuel_datetime DESC LIMIT 1');
    
        const lastRefuel_airplane_id = lastRefuel.length > 0 ? lastRefuel[0].airplane_id : null; 
        const lastRefuel_pilot_id = lastRefuel.length > 0 ? lastRefuel[0].pilot_id : null; 
    
        const [lastRefuelAirplane] = await pool.execute('SELECT tail_number FROM airplanes WHERE airplane_id = ?', [lastRefuel_airplane_id]);
        const [lastRefuelPilot] = await pool.execute('SELECT first_name, last_name FROM pilots WHERE pilot_id = ?', [lastRefuel_pilot_id]);

        return res.render('index', { 
            title: 'Operation - Refuel',
            page: 'operation-refuel',
            menuItems: menuItems,
            errors: alertMessages,
            user: req.session.user,
            airplanes: airplanes, 
            fuelTypes: fuelTypes ,
            pilots: pilots,
            lastRefuel : lastRefuel[0],
            lastRefuelAirplane: lastRefuelAirplane[0].tail_number, 
            lastRefuelPilotFirstName : lastRefuelPilot[0].first_name,
            lastRefuelPilotLastName : lastRefuelPilot[0].last_name
        });    
        } catch (error) {
          console.error('Error registering refuel:', error);
          req.flash('error', 'An error occurred while registering the refuel.');
          return res.render('index', { 
            title: 'Operation - Refuel',
            page: 'operation-refuel',
            menuItems: menuItems,
            errors: alertMessages.push('Error on getting information from Database, related to fuel, pilot or airplane'),
            user: req.session.user,
            airplanes: [''], 
            fuelTypes: [''] ,
            lastRefuel : [''],
            lastRefuelAirplane: ['']
          });
        }
      }
    // If validation passes, proceed to save data to the database
    const {airplane_id, fuel_type_name, pilot_id, fuel_quantity_liters, cost, added_mass} = req.body;

    try {
      // Check if valid Airplane ID
      const [test] = await pool.execute('SELECT tail_number FROM airplanes WHERE airplane_id = ?', [airplane_id]);
    } catch (error) {
      console.error('Error registering refuel:', error);
      req.flash('error', 'An error occurred while registering the refuel.');
      return res.render('index', { 
        title: 'Operation - Refuel',
        page: 'operation-refuel',
        menuItems: menuItems,
        errors: ['Error on getting information from Database, related to fuel, pilot or airplane'],
        user: req.session.user,
        airplanes: [''], 
        fuelTypes: [''] ,
        lastRefuel : [''],
        lastRefuelAirplane: ['']
      });
    }
    try {
      // Check if valid Fuel Type Name
      const [test] = await pool.execute('SELECT fuel_type_id FROM fuel_types WHERE fuel_name = ?', [fuel_type_name]);
    } catch (error) {
      console.error('Error registering refuel:', error);
      req.flash('error', 'An error occurred while registering the refuel.');
      return res.render('index', { 
        title: 'Operation - Refuel',
        page: 'operation-refuel',
        menuItems: menuItems,
        errors: ['Error on getting information from Database, related to fuel, pilot or airplane'],
        user: req.session.user,
        airplanes: [''], 
        fuelTypes: [''] ,
        lastRefuel : [''],
        lastRefuelAirplane: ['']
      });
    }
    try {
      // Check if valid Pilot Id
      const [test] = await pool.execute('SELECT first_name FROM pilots WHERE pilot_id = ?', [pilot_id]);
    } catch (error) {
      console.error('Error registering refuel:', error);
      req.flash('error', 'An error occurred while registering the refuel.');
      return res.render('index', { 
        title: 'Operation - Refuel',
        page: 'operation-refuel',
        menuItems: menuItems,
        errors: ['Error on getting information from Database, related to fuel, pilot or airplane'],
        user: req.session.user,
        airplanes: [''], 
        fuelTypes: [''] ,
        lastRefuel : [''],
        lastRefuelAirplane: ['']
      });
    }

    const [airplanes] = await pool.execute('SELECT airplane_id, tail_number FROM airplanes');
    const [fuelTypes] = await pool.execute('SELECT fuel_type_id, fuel_name FROM fuel_types');
    const [pilots] = await pool.execute('SELECT pilot_id, first_name, last_name FROM pilots');
    const [lastRefuel] = await pool.execute('SELECT airplane_id, fuel_type_id, pilot_id FROM refuels ORDER BY refuel_datetime DESC LIMIT 1');

    const lastRefuel_airplane_id = lastRefuel.length > 0 ? lastRefuel[0].airplane_id : null; 
    const lastRefuel_pilot_id = lastRefuel.length > 0 ? lastRefuel[0].pilot_id : null; 

    const [lastRefuelAirplane] = await pool.execute('SELECT tail_number FROM airplanes WHERE airplane_id = ?', [lastRefuel_airplane_id]);
    const [lastRefuelPilot] = await pool.execute('SELECT first_name, last_name FROM pilots WHERE pilot_id = ?', [lastRefuel_pilot_id]);

    try {

      const [fuel_info] = await pool.execute('SELECT fuel_type_id, price_per_liter FROM fuel_types WHERE fuel_name = ?', [fuel_type_name]);
      const [result] = await pool.execute('INSERT INTO refuels (airplane_id, refuel_datetime, fuel_type_id, fuel_quantity_liters, price_per_liter, cost, added_mass, pilot_id) \
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)', 
        [airplane_id, moment.utc().format('YYYY-MM-DD HH:mm:ss'), fuel_info[0].fuel_type_id, fuel_quantity_liters, fuel_info[0].price_per_liter, cost, added_mass, pilot_id]);
      
      console.log('New refuel created with ID:', result.insertId);
      req.flash('success', 'New Refuel registered successfully!');
      return res.redirect('/');

    } catch (error) {
      console.error('Error registering refuel:', error);
      req.flash('error', 'An error occurred while registering the refuel.');
      return res.render('index', { 
        title: 'Operation - Refuel',
        page: 'operation-refuel',
        menuItems: menuItems,
        errors: 'Some parameters are not valid or failed to write to database',
        user: req.session.user,
        airplanes: airplanes, 
        fuelTypes: fuelTypes ,
        pilots: pilots,
        lastRefuel : lastRefuel[0],
        lastRefuelAirplane: lastRefuelAirplane[0].tail_number, 
        lastRefuelPilotFirstName : lastRefuelPilot[0].first_name,
        lastRefuelPilotLastName : lastRefuelPilot[0].last_name
      }); 
    }
});
app.post('/operation/new-load', isLoggedIn, hasRoleLevel(2), 
  [
    check('airplane_id').notEmpty().withMessage('Airplane information is required'),
    check('pilot_id').notEmpty().withMessage('Pilot information is required'),

    check('takeoff_hour').notEmpty().withMessage('Takeoff Hour is required'),
    check('takeoff_hour').isTime({ format: 'HH:mm' }).withMessage('Invalid Takeoff Hour'),
  
    check('takeoff_date').notEmpty().withMessage('Takeoff Date is required'),
    check('takeoff_date').custom((value) => {
      return moment(value, 'YYYY-MM-DD', true).isValid(); 
    }).withMessage('Invalid Takeoff Date'),
    check('takeoff_date', 'Takeoff Date cannot be in the past').custom((value, { req }) => {
      const today = moment();
      const takeoffDateTime = moment(`${value} ${req.body.takeoff_hour}`, 'YYYY-MM-DD HH:mm');
      return takeoffDateTime.isSameOrAfter(today); 
    }),

  ],
  async (req, res) => {
    const errors = validationResult(req);
    
    if (!errors.isEmpty()) {
      // Handle validation errors
      const alertMessages = errors.array().map(error => error.msg);
      req.flash('error', alertMessages); 

      try {
        const [airplanes] = await pool.execute('SELECT airplane_id, tail_number FROM airplanes');
        const [pilots] = await pool.execute('SELECT pilot_id, first_name, last_name FROM pilots');
        const [lastLoad] = await pool.execute('SELECT airplane_id, pilot_id FROM loads ORDER BY takeoff_datetime DESC LIMIT 1');

        const lastload_airplane_id = lastLoad.length > 0 ? lastLoad[0].airplane_id : null; 
        const lastload_pilot_id = lastLoad.length > 0 ? lastLoad[0].pilot_id : null; 

        const [lastLoadAirplane] = await pool.execute('SELECT tail_number FROM airplanes WHERE airplane_id = ?', [lastload_airplane_id]);
        const [lastLoadPilot] = await pool.execute('SELECT first_name, last_name FROM pilots WHERE pilot_id = ?', [lastload_pilot_id]);

        return res.render('index', { 
            title: 'Operation - New Load',
            page: 'operation-new-load',
            menuItems: menuItems,
            errors: alertMessages,
            user: req.session.user,
            airplanes: airplanes,
            pilots: pilots,
            lastload: lastLoad[0],
            lastLoadAirplane: lastLoadAirplane[0].tail_number,
            lastLoadPilot: lastLoadPilot[0]
          });    
        } catch (error) {
          console.error('Error registering New Load:', error);
          req.flash('error', 'An error occurred while registering New Load.');
          return res.render('index', { 
              title: 'Operation - New Load',
              page: 'operation-new-load',
              menuItems: menuItems,
              errors: alertMessages,
              user: req.session.user,
              airplanes: [''],
              pilots: [''],
              lastload: [''],
              lastLoadAirplane: [''],
              lastLoadPilot: ['']
            }); 
        }
      }
    
    custom_errors = [];
    const { airplane_id, pilot_id, takeoff_hour, takeoff_date, status, notes } = req.body;
    try {
      // Check operation validity for creating the load.
      const [pilot_info] = await pool.execute('SELECT license_expiration_date, medical_expiration_date FROM pilots WHERE pilot_id = ?', [pilot_id]);
      if (moment().isAfter(moment(pilot_info[0].license_expiration_date, true))) {
        custom_errors.push('Pilot License has expired.');
      }
      if (moment().isAfter(moment(pilot_info[0].medical_expiration_date, true))) {
        custom_errors.push('Pilot Medical has expired.');
      }

      if(custom_errors.length > 0) {
        req.flash('error', 'An error occurred while registering New Load.');
        return res.render('index', { 
            title: 'Operation - New Load',
            page: 'operation-new-load',
            menuItems: menuItems,
            errors: custom_errors,
            user: req.session.user,
            airplanes: [''],
            pilots: [''],
            lastload: [''],
            lastLoadAirplane: [''],
            lastLoadPilot: ['']
          }); 
      }
      
    } catch (error) {
      console.error('Error registering New Load:', error);
      req.flash('error', 'An error occurred while registering New Load.');
      return res.render('index', { 
          title: 'Operation - New Load',
          page: 'operation-new-load',
          menuItems: menuItems,
          errors: ['Error loading information from Database'],
          user: req.session.user,
          airplanes: [''],
          pilots: [''],
          lastload: [''],
          lastLoadAirplane: [''],
          lastLoadPilot: ['']
        }); 
    }
    // If validation passes, proceed to save data to the database

    const [airplanes] = await pool.execute('SELECT airplane_id, tail_number FROM airplanes');
    const [pilots] = await pool.execute('SELECT pilot_id, first_name, last_name FROM pilots');
    const [lastLoad] = await pool.execute('SELECT airplane_id, pilot_id FROM loads ORDER BY takeoff_datetime DESC LIMIT 1');

    const lastload_airplane_id = lastLoad.length > 0 ? lastLoad[0].airplane_id : null; 
    const lastload_pilot_id = lastLoad.length > 0 ? lastLoad[0].pilot_id : null; 

    const [lastLoadAirplane] = await pool.execute('SELECT tail_number FROM airplanes WHERE airplane_id = ?', [lastload_airplane_id]);
    const [lastLoadPilot] = await pool.execute('SELECT first_name, last_name FROM pilots WHERE pilot_id = ?', [lastload_pilot_id]);

    try {
      // Combine takeoff_date and takeoff_hour
      const takeoffDateTime = new Date(`${takeoff_date} ${takeoff_hour}`);
      // Checks the status of the load, if it is 'yes' it will be 1, otherwise it will be 0
      let statusInt = (status === '1') ? 1 : 0;
  
      // Insert data into the database
      const [result] = await pool.execute('INSERT INTO loads (airplane_id, pilot_id, takeoff_datetime, status, notes) VALUES (?, ?, ?, ?, ?)', 
        [airplane_id, pilot_id, takeoffDateTime, statusInt, notes]); 
    
      console.log('New Load created with ID:', result.insertId);
      req.flash('success', 'New Load registered successfully!');
      return res.redirect('/');

    } catch (error) {
      console.error('Error registering New Load:', error);
      req.flash('error', 'An error occurred while registering New Load.');
      return res.render('index', { 
          title: 'Operation - New Load',
          page: 'operation-new-load',
          menuItems: menuItems,
          errors: ['An error occurred while registering New Load.'],
          user: req.session.user,
          airplanes: airplanes,
          pilots: pilots,
          lastload: lastLoad[0],
          lastLoadAirplane: lastLoadAirplane[0].tail_number,
          lastLoadPilot: lastLoadPilot[0]
      });
    }
});
app.post('/transactions/create/funjumper', isLoggedIn, hasRoleLevel(2), 
  [
    check('funjumper_id').notEmpty().withMessage('Funjumper information is required'),
    check('funjumper_id').isInt({min:0}).withMessage('Invalid Funjumper ID'),
    check('transaction_type').notEmpty().withMessage('Transaction Type is required'),
    check('transaction_type').isIn(['buy_jumpticket','cancel_jumpticket', 'jump', 'cancel_jump', 'other']).withMessage('Invalid Transaction Type'),
    check('amount').notEmpty().withMessage('Amount is required'),
    check('amount').isFloat({min:0}).withMessage('Amount must be a non-negative number')
  ],
  async (req, res) => {

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Handle validation errors
      const alertMessages = errors.array().map(error => error.msg);
      req.flash('error', alertMessages); 
  
      return res.render('index', { 
        title: 'New Transaction',
        page: 'new-transaction',
        menuItems: menuItems,
        errors: alertMessages,
        success: '',
        user: req.session.user
      });
    }

    try {
      const { funjumperSearch, funjumper_id, transaction_type, amount, notes } = req.body;

      if (transaction_type === 'buy_jumpticket') { // Transform Balance money into jumptickets
        const transactionDataTickets = {
          transaction_type: transaction_type, 
          funjumper_id: funjumper_id, 
          pilot_id: null,
          tandem_id: null,
          amount: +amount, 
          notes: notes
        };
        const transactionIdBalance = await createTransaction(transactionDataTickets);
        const successMessage = [`${funjumperSearch} account`,
                          'Transaction created successfully.', 
                          `${transactionDataTickets.amount} New Jump Tickets`,
                          `Transaction IDs: ${transactionIdBalance}`];
        return res.status(201).render('index', { 
          title: 'New Transaction',
          page: 'new-transaction',
          menuItems: menuItems,
          errors: '',
          success: successMessage,
          user: req.session.user
        });
      }

      if (transaction_type === 'cancel_jumpticket') { // Cancels the jump ticket and returns the money to the balance account
        const transactionDataTickets = {
          transaction_type: transaction_type, 
          funjumper_id: funjumper_id, 
          pilot_id: null,
          tandem_id: null,
          amount: -amount, 
          notes: notes
        };
        const transactionIdBalance = await createTransaction(transactionDataTickets);
        const successMessage = [ `${funjumperSearch} account`,
                          'Transaction created successfully.', 
                          `Removed ${transactionDataTickets.amount} Jump Tickets`,
                          `Transaction IDs: ${transactionIdBalance}`];
        return res.status(201).render('index', { 
          title: 'New Transaction',
          page: 'new-transaction',
          menuItems: menuItems,
          errors: '',
          success: successMessage,
          user: req.session.user
        });
      }
  
    } catch (error) {
      console.error('Error creating transaction:', error);
      res.status(500).render('index', { 
        title: 'New Transaction',
        page: 'new-transaction',
        menuItems: menuItems,
        errors: `Error creating transaction: ${error}`,
        success: '',
        user: req.session.user
      });
    }
});

// --- TANDEM RELATED ---
app.post('/tandem/checkin', isLoggedIn, hasRoleLevel(2), 
  [
    check('first_name').notEmpty().withMessage('First Name is required'),
    check('last_name').notEmpty().withMessage('Last Name is required'),
    check('date_of_birth').notEmpty().withMessage('Date of Birth is required'),
    check('date_of_birth').isDate().withMessage('Invalid Date of Birth'),
    check('phone_number').notEmpty().withMessage('Phone Number is required'),
    check('phone_number').isMobilePhone().withMessage('Invalid Phone Number'),
    check('emergency_contact_name').notEmpty().withMessage('Emergency Contact Name is required'),
    check('emergency_contact_phone').notEmpty().withMessage('Emergency Contact Phone is required'),
    check('emergency_contact_phone').isMobilePhone().withMessage('Invalid Emergency Contact Phone number'),
    check('emergency_contact_relation').notEmpty().withMessage('Emergency Contact Relation is required'),
    check('civil_id_expires').custom((value) => {
      const expire_date = moment(value, 'YYYY-MM-DD');
      return expire_date.isValid() && expire_date.isAfter(moment());}).withMessage('Civil ID Expire must be a valid date in the future'),
  ],
  async (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      // Handle validation errors
      const alertMessages = errors.array().map(error => error.msg);
      req.flash('error', alertMessages); 
      return res.status(400).render('index', { 
        title: 'Tandem Checkin', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'tandem-checkin',
        errors: alertMessages,
        success: ''
      });
    }

    // If validation passes, proceed to save data to the database
    const {
      first_name,
      middle_names,
      last_name,
      date_of_birth,
      civil_id_number,
      civil_id_expires,
      nationality,
      email,
      phone_number,
      street_address,
      city_address,
      postal_code,
      country,
      emergency_contact_name,
      emergency_contact_relation,
      emergency_contact_phone,
      notes
    } = req.body;

    try {

      const [passenger_db] = await pool.execute(
        `INSERT INTO passengers 
        (first_name, middle_names, last_name, date_of_birth, civil_id_number, civil_id_expires, nationality, 
        email, phone_number, street_address, city_address, postal_code, country, 
        emergency_contact_name, emergency_contact_relation, emergency_contact_phone) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          first_name, handleUndefined(middle_names), last_name, date_of_birth, handleUndefined(civil_id_number), civil_id_expires, handleUndefined(nationality),
          handleUndefined(email), handleUndefined(phone_number), handleUndefined(street_address), handleUndefined(city_address), handleUndefined(postal_code), handleUndefined(country),
          emergency_contact_name, emergency_contact_relation, emergency_contact_phone,
        ]
      );

      const waiver_signed = req.body.waiverSigner === 'on' ? 1 : 0; // Convert checkbox to 1 or 0
      const photos = req.body.photos === 'on' ? 1 : 0; // Convert checkbox to 1 or 0
      const video = req.body.video === 'on' ? 1 : 0; // Convert checkbox to 1 or 0

      const [tandem] = await pool.execute(
        `INSERT INTO tandems (passenger_id, waiver_signed, photos, videos, notes) 
        VALUES (?,?,?,?,?)`,
        [
          passenger_db.insertId, waiver_signed, photos, video, notes
        ]
      );

      console.log(`Passenger ID: ${passenger_db.insertId}, Tandem ID: ${tandem.insertId}`);

      req.flash('success', 'Tandem Checkin successful!');
      return res.status(400).render('index', { 
        title: 'Tandem Checkin', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'tandem-checkin',
        errors: '',
        success: ['Success on Tandem Checkin!', `Passenger Name: ${first_name} ${middle_names} ${last_name} , Tandem ID: ${tandem.insertId}`], 
      });


    } catch (err) {
      console.error('Error checkin in Tandem:', err);
      req.flash('error', 'An error occurred. Please try again.');
      return res.status(400).render('index', { 
        title: 'Tandem Checkin', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'tandem-checkin',
        errors: ['Database error tandem checkin.'],
        success: ''
      });
    }
  }
);
app.post('/register/new-instructor', isLoggedIn, hasRoleLevel(2),
  [
    check('selectedFunjumperId').notEmpty().withMessage('No Funjumper selected')
  ],
  async (req, res) => {
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
      // Handle validation errors
      const alertMessages = errors.array().map(error => error.msg);
      req.flash('error', alertMessages); 
      return res.status(400).render('index', { 
        title: 'Register New Instructor', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'register-new-instructor',
        errors: alertMessages,
        success: ''
      });
    }

    const {
      selectedFunjumperId,
      tandem_jumps,
      notes
    } = req.body;
    const camera_rating = req.body.camera_rating === 'on' ? 1 : 0; // Convert checkbox to 1 or 0
    const tandem_rating = req.body.tandem_rating === 'on' ? 1 : 0; // Convert checkbox to 1 or 0

    try {
      const [instructorResult] = await pool.execute(
        'INSERT INTO tandem_instructors (funjumper_id, tandem_rating, camera_rating, tandem_jumps, jump_balance, notes) VALUES (?, ?, ?, ?, ?, ?)',
        [selectedFunjumperId, tandem_rating, camera_rating, tandem_jumps, 0, notes]
      );

      const instructorId = instructorResult.insertId; // Get the generated instructor ID
      console.log('Instructor added with ID:', instructorId);
      return res.status(400).render('index', { 
        title: 'Register New Instructor', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'register-new-instructor',
        errors: '',
        success: [`Success adding Funjumper ID ${selectedFunjumperId} as Instructor ID ${instructorId}`]
      });
      
    } catch (error) {
      console.error('Error adding instructor:', error);
      return res.status(400).render('index', { 
        title: 'Register New Instructor', 
        menuItems: menuItems, 
        user: req.session.user,
        page: 'register-new-instructor',
        errors: ['An error occurred while adding the instructor'],
        success: ''
      });
    }


  });

// <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<< [ LISTEN ] >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});