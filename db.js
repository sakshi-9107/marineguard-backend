const mysql = require("mysql2");

const db = mysql.createConnection({
    host: "localhost",
    user: "root",
    password: "Sakshi123",
    database: "marineguard"
});

db.connect((error) => {

    if (error) {

        console.error("❌ MySQL connection failed:");
        console.error(error.message);

        return;

    }

    console.log("✅ Connected to MarineGuard MySQL database!");

});

module.exports = db;