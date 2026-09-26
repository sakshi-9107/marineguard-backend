const mysql = require("mysql2");

const db = mysql.createConnection({

    host: process.env.MYSQLHOST,

    port: process.env.MYSQLPORT,

    user: process.env.MYSQLUSER,

    password: process.env.MYSQLPASSWORD,

    database: process.env.MYSQLDATABASE

});

db.connect((error) => {

    if (error) {

        console.error("❌ MySQL connection failed:");
        console.error(error.message);

        return;

    }

    console.log(
        "✅ Connected to MarineGuard MySQL database!"
    );

});

module.exports = db;