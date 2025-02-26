const mysql = require('mysql2/promise');

// Pool Connecting to the MariaDB Database:
const pool = mysql.createPool({
  host: '172.20.0.3',
  user: 'root',
  password: 'KeH9RAJMdJrD7RpwKi',
  database: 'skydive_dunas'
});

module.exports = pool;