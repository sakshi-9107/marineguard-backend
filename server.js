require("dotenv").config();
const nodemailer = require("nodemailer");

const express = require("express");
const cors = require("cors");
const multer = require("multer");

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_APP_PASSWORD
    }
});

function generateOTP() {
    return Math.floor(
        100000 + Math.random() * 900000
    ).toString();
}

const db = require("./db");

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const JWT_SECRET = "marineguard_secret_key_2026";

const app = express();

const PORT = 3000;


// ==========================================
// MIDDLEWARE
// ==========================================

app.use(cors());

app.use(express.json());


// ==========================================
// IMAGE UPLOAD CONFIGURATION
// ==========================================

const upload = multer({
    storage: multer.memoryStorage()
});


// ==========================================
// VERIFY ADMIN / PROGRAMMER JWT TOKEN
// ==========================================

function verifyAdminToken(req, res, next) {

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {

        return res.status(401).json({
            success: false,
            message: "Access denied. Programmer login required."
        });

    }

    const token = authHeader.split(" ")[1];

    try {

        const decoded = jwt.verify(
            token,
            JWT_SECRET
        );

        // Make sure this is an ADMIN token
        if (decoded.role !== "admin") {

            return res.status(403).json({
                success: false,
                message: "Programmer access required."
            });

        }

        req.admin = decoded;

        next();

    } catch (error) {

        return res.status(401).json({
            success: false,
            message: "Invalid or expired programmer login."
        });

    }

}


// ==========================================
// VERIFY USER JWT TOKEN
// ==========================================

function verifyUserToken(req, res, next) {

    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {

        return res.status(401).json({
            success: false,
            message: "User authentication required."
        });

    }

    const token = authHeader.split(" ")[1];

    try {

        const decoded = jwt.verify(
            token,
            JWT_SECRET
        );

        // Make sure this is a USER token
        if (decoded.role !== "user") {

            return res.status(403).json({
                success: false,
                message: "User access required."
            });

        }

        req.user = decoded;

        next();

    } catch (error) {

        console.error(
            "User token verification failed:",
            error.message
        );

        return res.status(401).json({
            success: false,
            message: "Invalid or expired user session."
        });

    }

}


// ==========================================
// TEST BACKEND
// ==========================================

app.get("/", (req, res) => {

    res.send(
        "🌊 MarineGuard Backend is running!"
    );

});


// ==========================================
// TEST DATABASE
// ==========================================

app.get("/test-db", (req, res) => {

    db.query(
        "SELECT 1 AS test",
        (error, results) => {

            if (error) {

                console.error(error);

                return res.status(500).json({
                    success: false,
                    message: "Database connection failed"
                });

            }

            res.json({

                success: true,

                message:
                    "✅ MarineGuard MySQL database connected successfully!",

                result: results

            });

        }
    );

});


// SUBMIT POLLUTION REPORT
app.post(
    "/api/reports",
    verifyUserToken,
    upload.single("uploaded_image"),
    (req, res) => {

        try {

            const {
                report_code,
                pollution_type,
                pollution_confidence,
                severity,
                severity_confidence,
                latitude,
                longitude
            } = req.body;

            const user_id = req.user.user_id;

            // CHECK IMAGE
            if (!req.file) {
                return res.status(400).json({
                    success: false,
                    message: "Please upload an image."
                });
            }

            // CHECK REQUIRED DATA
            if (
                !report_code ||
                !user_id ||
                !pollution_type ||
                !severity ||
                latitude === undefined ||
                longitude === undefined
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Required report information is missing."
                });
            }

            const lat = Number(latitude);
            const lng = Number(longitude);

            // CHECK GPS VALUES
            if (
                !Number.isFinite(lat) ||
                !Number.isFinite(lng)
            ) {
                return res.status(400).json({
                    success: false,
                    message:
                        "Invalid GPS coordinates."
                });
            }

            // =====================================================
            // DUPLICATE POLLUTION CHECK
            // Same pollution type within 50 metres
            // =====================================================

            const duplicateSql = `
                SELECT
                    report_id,
                    report_code,
                    pollution_type,
                    latitude,
                    longitude,
                    status
                FROM reports
                WHERE pollution_type = ?
                AND (
                    6371000 * ACOS(
                        COS(RADIANS(?))
                        * COS(RADIANS(latitude))
                        * COS(
                            RADIANS(longitude) -
                            RADIANS(?)
                        )
                        + SIN(RADIANS(?))
                        * SIN(RADIANS(latitude))
                    )
                ) <= 50
                LIMIT 1
            `;

            db.query(
                duplicateSql,
                [
                    pollution_type,
                    lat,
                    lng,
                    lat
                ],
                (duplicateError, duplicateResults) => {

                    // DUPLICATE CHECK ERROR
                    if (duplicateError) {

                        console.error(
                            "❌ Duplicate check error:",
                            duplicateError
                        );

                        return res.status(500).json({
                            success: false,
                            message:
                                "Unable to check for duplicate pollution reports."
                        });
                    }

                    // =================================================
                    // DUPLICATE FOUND
                    // =================================================

                    if (duplicateResults.length > 0) {

                        const existingReport =
                            duplicateResults[0];

                        console.log(
                            "⚠️ Duplicate pollution report blocked:",
                            existingReport.report_code
                        );

                        return res.status(409).json({
                            success: false,
                            duplicate: true,
                            message:
                                "This pollution has already been reported at this location.",
                            existing_report:
                                existingReport.report_code
                        });
                    }

                    // =================================================
                    // NO DUPLICATE → INSERT NEW REPORT
                    // =================================================

                    const insertSql = `
                        INSERT INTO reports (
                            report_code,
                            user_id,
                            uploaded_image,
                            image_type,
                            pollution_type,
                            pollution_confidence,
                            severity,
                            severity_confidence,
                            latitude,
                            longitude
                        )
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `;

                    const values = [
                        report_code,
                        Number(user_id),
                        req.file.buffer,
                        req.file.mimetype,
                        pollution_type,
                        pollution_confidence
                            ? Number(pollution_confidence)
                            : null,
                        severity,
                        severity_confidence
                            ? Number(severity_confidence)
                            : null,
                        lat,
                        lng
                    ];

                    db.query(
                        insertSql,
                        values,
                        (insertError, result) => {

                            if (insertError) {

                                console.error(
                                    "❌ Database insert error:",
                                    insertError
                                );

                                return res.status(500).json({
                                    success: false,
                                    message:
                                        "Failed to save report."
                                });
                            }

                            console.log(
                                "✅ Report saved:",
                                report_code,
                                "for user:",
                                user_id
                            );

                            return res.status(201).json({
                                success: true,
                                message:
                                    "✅ Report saved successfully!",
                                report_id:
                                    result.insertId,
                                report_code:
                                    report_code
                            });
                        }
                    );
                }
            );

        } catch (error) {

            console.error(
                "❌ Server error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Server error."
            });
        }
    }
);


// ==========================================
// GET MY REPORTS
// ==========================================
// USER LOGIN REQUIRED
// User ID comes from VERIFIED JWT
// ==========================================

app.get(
    "/api/reports/my-reports",

    verifyUserToken,

    (req, res) => {

        // ==========================================
        // GET USER ID FROM JWT
        // ==========================================

        const userId = req.user.user_id;


        // ==========================================
        // SQL QUERY
        // ==========================================

        const sql = `

            SELECT

                report_id,
                report_code,
                user_id,
                image_type,
                pollution_type,
                pollution_confidence,
                severity,
                severity_confidence,
                latitude,
                longitude,
                reported_date,
                status,
                completed_date

            FROM reports

            WHERE user_id = ?

            ORDER BY reported_date DESC

        `;


        // ==========================================
        // GET REPORTS
        // ==========================================

        db.query(

            sql,

            [userId],

            (error, results) => {

                if (error) {

                    console.error(
                        "❌ Error fetching reports:",
                        error
                    );

                    return res.status(500).json({

                        success: false,

                        message:
                            "Unable to fetch reports."

                    });

                }


                // ==================================
                // SUCCESS
                // ==================================

                res.json({

                    success: true,

                    reports: results

                });

            }

        );

    }

);

// ==========================================
// GET UPLOADED IMAGE
// ==========================================

app.get(
    "/api/reports/image/:reportId",

    (req, res) => {

        const reportId =
            Number(req.params.reportId);


        const sql = `

            SELECT

                uploaded_image,
                image_type

            FROM reports

            WHERE report_id = ?

        `;


        db.query(

            sql,

            [reportId],

            (error, results) => {

                if (error) {

                    console.error(
                        "❌ Error fetching image:",
                        error
                    );

                    return res.status(500).send(
                        "Unable to fetch image."
                    );

                }


                if (results.length === 0) {

                    return res.status(404).send(
                        "Image not found."
                    );

                }


                const image =
                    results[0].uploaded_image;


                const imageType =
                    results[0].image_type ||
                    "image/jpeg";


                res.setHeader(
                    "Content-Type",
                    imageType
                );


                res.send(image);

            }

        );

    }

);


// ==========================================
// PROGRAMMER - MARK REPORT AS COMPLETED
// ==========================================

app.put(

    "/api/reports/:reportId/complete",

    verifyAdminToken,

    (req, res) => {

        const reportId =
            Number(req.params.reportId);


        if (!reportId) {

            return res.status(400).json({

                success: false,

                message:
                    "Invalid report ID."

            });

        }


        const sql = `

            UPDATE reports

            SET

                status = 'Completed',

                completed_date =
                    CURRENT_TIMESTAMP

            WHERE report_id = ?

        `;


        db.query(

            sql,

            [reportId],

            (error, result) => {

                if (error) {

                    console.error(
                        "❌ Error completing report:",
                        error
                    );

                    return res.status(500).json({

                        success: false,

                        message:
                            "Unable to complete report."

                    });

                }


                if (result.affectedRows === 0) {

                    return res.status(404).json({

                        success: false,

                        message:
                            "Report not found."

                    });

                }


                res.json({

                    success: true,

                    message:
                        "✅ Report marked as completed."

                });

            }

        );

    }

);


// ==========================================
// GET ALL REPORTS
// PROGRAMMER DASHBOARD
// ==========================================

app.get(

    "/api/reports/all",

    verifyAdminToken,

    (req, res) => {

        const sql = `

            SELECT

                report_id,
                report_code,
                user_id,
                image_type,
                pollution_type,
                pollution_confidence,
                severity,
                severity_confidence,
                latitude,
                longitude,
                reported_date,
                status,
                completed_date

            FROM reports

            ORDER BY reported_date DESC

        `;


        db.query(

            sql,

            (error, results) => {

                if (error) {

                    console.error(
                        "❌ Error fetching all reports:",
                        error
                    );

                    return res.status(500).json({

                        success: false,

                        message:
                            "Unable to fetch reports."

                    });

                }


                res.json({

                    success: true,

                    reports: results

                });

            }

        );

    }

);


// ==========================================
// PROGRAMMER / ADMIN REGISTER
// ==========================================

app.post(

    "/api/admin/register",

    async (req, res) => {

        const {
            name,
            email,
            password
        } = req.body;


        if (
            !name ||
            !email ||
            !password
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Name, email and password are required."

            });

        }


        try {

            const passwordHash =
                await bcrypt.hash(
                    password,
                    10
                );


            const sql = `

                INSERT INTO admins (
                    name,
                    email,
                    password_hash
                )

                VALUES (?, ?, ?)

            `;


            db.query(

                sql,

                [
                    name,
                    email,
                    passwordHash
                ],

                (error, result) => {

                    if (error) {

                        console.error(
                            "Admin registration error:",
                            error
                        );

                        return res.status(500).json({

                            success: false,

                            message:
                                "Unable to create programmer account."

                        });

                    }


                    res.json({

                        success: true,

                        message:
                            "Programmer account created successfully.",

                        admin_id:
                            result.insertId

                    });

                }

            );


        } catch (error) {

            console.error(
                "Password hashing error:",
                error
            );


            res.status(500).json({

                success: false,

                message:
                    "Server error."

            });

        }

    }

);


// ==========================================
// PROGRAMMER / ADMIN LOGIN
// ==========================================

app.post(

    "/api/admin/login",

    (req, res) => {

        const {
            email,
            password
        } = req.body;


        if (
            !email ||
            !password
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Email and password are required."

            });

        }


        const sql = `

            SELECT

                admin_id,
                name,
                email,
                password_hash

            FROM admins

            WHERE email = ?

        `;


        db.query(

            sql,

            [email],

            async (error, results) => {

                if (error) {

                    console.error(
                        "Admin login error:",
                        error
                    );

                    return res.status(500).json({

                        success: false,

                        message:
                            "Database error."

                    });

                }


                if (results.length === 0) {

                    return res.status(401).json({

                        success: false,

                        message:
                            "Invalid email or password."

                    });

                }


                const admin =
                    results[0];


                const passwordMatch =
                    await bcrypt.compare(

                        password,

                        admin.password_hash

                    );


                if (!passwordMatch) {

                    return res.status(401).json({

                        success: false,

                        message:
                            "Invalid email or password."

                    });

                }


                // ==================================
                // CREATE ADMIN JWT
                // ==================================

                const token =
                    jwt.sign(

                        {

                            admin_id:
                                admin.admin_id,

                            email:
                                admin.email,

                            name:
                                admin.name,

                            role:
                                "admin"

                        },

                        JWT_SECRET,

                        {
                            expiresIn: "2h"
                        }

                    );


                res.json({

                    success: true,

                    message:
                        "Login successful.",

                    token: token,

                    admin: {

                        admin_id:
                            admin.admin_id,

                        name:
                            admin.name,

                        email:
                            admin.email

                    }

                });

            }

        );

    }

);


// ==========================================
// USER REGISTRATION - SEND OTP
// ==========================================

app.post(
    "/api/users/register",
    async (req, res) => {

        const {
            name,
            email,
            password
        } = req.body;

        // ==========================================
        // REQUIRED FIELDS
        // ==========================================

        if (!name || !email || !password) {
            return res.status(400).json({
                success: false,
                message:
                    "Name, email and password are required."
            });
        }

        // ==========================================
        // VALIDATE EMAIL
        // ==========================================

        const emailPattern =
            /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

        if (!emailPattern.test(email)) {
            return res.status(400).json({
                success: false,
                message:
                    "Please enter a valid email address."
            });
        }

        // ==========================================
        // VALIDATE PASSWORD
        // ==========================================

        const passwordPattern =
            /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;

        if (!passwordPattern.test(password)) {
            return res.status(400).json({
                success: false,
                message:
                    "Password must contain 8+ characters, uppercase, lowercase, number and special character."
            });
        }

        try {

            // ==========================================
            // CHECK IF EMAIL ALREADY EXISTS
            // ==========================================

            const checkUserSql = `
                SELECT user_id
                FROM users
                WHERE email = ?
                LIMIT 1
            `;

            db.query(
                checkUserSql,
                [email],
                async (error, users) => {

                    if (error) {
                        console.error(
                            "Email check error:",
                            error
                        );

                        return res.status(500).json({
                            success: false,
                            message:
                                "Unable to check email."
                        });
                    }

                    if (users.length > 0) {
                        return res.status(409).json({
                            success: false,
                            message:
                                "Email already registered."
                        });
                    }

                    // ==========================================
                    // GENERATE OTP
                    // ==========================================

                    const otp = generateOTP();

                    // ==========================================
                    // HASH PASSWORD
                    // ==========================================

                    const passwordHash =
                        await bcrypt.hash(
                            password,
                            10
                        );

                    // ==========================================
                    // HASH OTP
                    // ==========================================

                    const otpHash =
                        await bcrypt.hash(
                            otp,
                            10
                        );

                    // OTP valid for 5 minutes
                    const expiresAt =
                        new Date(
                            Date.now() +
                            5 * 60 * 1000
                        );

                    // ==========================================
                    // DELETE OLD OTP
                    // ==========================================

                    const deleteOldSql = `
                        DELETE FROM email_verifications
                        WHERE email = ?
                    `;

                    db.query(
                        deleteOldSql,
                        [email],
                        (deleteError) => {

                            if (deleteError) {
                                console.error(
                                    "Old verification delete error:",
                                    deleteError
                                );

                                return res.status(500).json({
                                    success: false,
                                    message:
                                        "Unable to start verification."
                                });
                            }

                            // ==========================================
                            // SAVE TEMPORARY REGISTRATION DATA
                            // ==========================================

                            const insertVerificationSql = `
                                INSERT INTO email_verifications (
                                    name,
                                    email,
                                    password_hash,
                                    otp_hash,
                                    expires_at
                                )
                                VALUES (?, ?, ?, ?, ?)
                            `;

                            db.query(
                                insertVerificationSql,
                                [
                                    name,
                                    email,
                                    passwordHash,
                                    otpHash,
                                    expiresAt
                                ],
                                async (insertError) => {

                                    if (insertError) {
                                        console.error(
                                            "Verification insert error:",
                                            insertError
                                        );

                                        return res.status(500).json({
                                            success: false,
                                            message:
                                                "Unable to start email verification."
                                        });
                                    }

                                    // ==========================================
                                    // SEND OTP EMAIL
                                    // ==========================================

                                    try {
                                        await transporter.sendMail({
                                            from:
                                                `"MarineGuard" <${process.env.EMAIL_USER}>`,
                                                
                                            to: email,
                                            
                                            subject:
                                                "MarineGuard Email Verification OTP",
                                                
                                            html: `
                                                <div style="
                                                    font-family: Arial, sans-serif;
                                                    max-width: 600px;
                                                    margin: auto;
                                                    padding: 25px;
                                                    border: 1px solid #ddd;
                                                    border-radius: 12px;
                                                ">
                                                
                                                    <h2 style="color:#087f8c;">
                                                        MarineGuard Email Verification
                                                    </h2>

                                                    <p>
                                                        Hello <b>${name}</b>,
                                                    </p>

                                                    <p>
                                                        Thank you for registering
                                                        with MarineGuard.
                                                    </p>

                                                    <p>
                                                        Your verification OTP is:
                                                    </p>

                                                    <div style="
                                                        font-size: 32px;
                                                        font-weight: bold;
                                                        letter-spacing: 8px;
                                                        text-align: center;
                                                        padding: 15px;
                                                        background: #eefbfc;
                                                        border-radius: 10px;
                                                        color: #087f8c;
                                                    ">
                                                        ${otp}
                                                    </div>

                                                    <p>
                                                        This OTP is valid for
                                                        <b>5 minutes</b>.
                                                    </p>

                                                    <p>
                                                        If you did not request
                                                        this registration, you
                                                        can ignore this email.
                                                    </p>

                                                    <p>
                                                        Regards,<br>
                                                        <b>MarineGuard Team</b>
                                                    </p>

                                                </div>
                                            `
                                        });

                                        console.log(
                                            "✅ OTP sent to:",
                                            email
                                        );

                                        return res.json({
                                            success: true,
                                            verificationRequired: true,
                                            message:
                                                "OTP sent successfully to your email."
                                        });

                                    } catch (emailError) {

                                        console.error(
                                            "OTP email sending error:",
                                            emailError
                                        );

                                        // ==========================================
                                        // INVALID / UNDELIVERABLE EMAIL
                                        // ==========================================

                                        const errorMessage =
                                            (
                                                emailError.message ||
                                                ""
                                            ).toLowerCase();

                                        if (
                                            emailError.code === "EENVELOPE" ||
                                            errorMessage.includes("recipient") ||
                                            errorMessage.includes("address") ||
                                            errorMessage.includes("mailbox") ||
                                            errorMessage.includes("user unknown") ||
                                            errorMessage.includes("not found") ||
                                            errorMessage.includes("does not exist")
                                        ) {

                                            return res.status(400).json({
                                                success: false,
                                                message:
                                                    "Please enter a correct email address. This email address could not receive the OTP."
                                            });
                                        }

                                        return res.status(500).json({
                                            success: false,
                                            message:
                                                "Unable to send OTP email. Please try again."
                                        });
                                    }
                                }
                            );
                        }
                    );
                }
            );

        } catch (error) {

            console.error(
                "Registration error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Server error."
            });
        }
    }
);

// ==========================================
// VERIFY EMAIL OTP
// ==========================================

app.post(
    "/api/users/verify-email",
    async (req, res) => {

        const {
            email,
            otp
        } = req.body;

        // ==========================================
        // REQUIRED FIELDS
        // ==========================================

        if (!email || !otp) {
            return res.status(400).json({
                success: false,
                message:
                    "Email and OTP are required."
            });
        }

        try {

            // ==========================================
            // FIND TEMPORARY VERIFICATION
            // ==========================================

            const findVerificationSql = `
                SELECT
                    verification_id,
                    name,
                    email,
                    password_hash,
                    otp_hash,
                    expires_at
                FROM email_verifications
                WHERE email = ?
                LIMIT 1
            `;

            db.query(
                findVerificationSql,
                [email],
                async (error, rows) => {

                    if (error) {
                        console.error(
                            "Verification lookup error:",
                            error
                        );

                        return res.status(500).json({
                            success: false,
                            message:
                                "Unable to verify OTP."
                        });
                    }

                    if (rows.length === 0) {
                        return res.status(404).json({
                            success: false,
                            message:
                                "No OTP verification request found. Please register again."
                        });
                    }

                    const verification = rows[0];

                    // ==========================================
                    // CHECK OTP EXPIRY
                    // ==========================================

                    if (
                        new Date() >
                        new Date(verification.expires_at)
                    ) {

                        // Delete expired verification
                        db.query(
                            `
                            DELETE FROM email_verifications
                            WHERE verification_id = ?
                            `,
                            [verification.verification_id]
                        );

                        return res.status(400).json({
                            success: false,
                            message:
                                "OTP has expired. Please register again."
                        });
                    }

                    // ==========================================
                    // CHECK OTP
                    // ==========================================

                    const otpCorrect =
                        await bcrypt.compare(
                            otp.toString(),
                            verification.otp_hash
                        );

                    if (!otpCorrect) {
                        return res.status(400).json({
                            success: false,
                            message:
                                "Incorrect OTP. Please try again."
                        });
                    }

                    // ==========================================
                    // CREATE USER AFTER OTP SUCCESS
                    // ==========================================

                    const insertUserSql = `
                        INSERT INTO users (
                            name,
                            email,
                            password
                        )
                        VALUES (?, ?, ?)
                    `;

                    db.query(
                        insertUserSql,
                        [
                            verification.name,
                            verification.email,
                            verification.password_hash
                        ],
                        (insertError, result) => {

                            if (insertError) {

                                console.error(
                                    "User creation after verification error:",
                                    insertError
                                );

                                if (
                                    insertError.code ===
                                    "ER_DUP_ENTRY"
                                ) {
                                    return res.status(409).json({
                                        success: false,
                                        message:
                                            "Email already registered."
                                    });
                                }

                                return res.status(500).json({
                                    success: false,
                                    message:
                                        "Unable to create user account."
                                });
                            }

                            // ==========================================
                            // DELETE TEMPORARY VERIFICATION
                            // ==========================================

                            db.query(
                                `
                                DELETE FROM email_verifications
                                WHERE verification_id = ?
                                `,
                                [verification.verification_id],
                                (deleteError) => {

                                    if (deleteError) {
                                        console.error(
                                            "Verification cleanup error:",
                                            deleteError
                                        );
                                    }

                                    return res.status(201).json({
                                        success: true,
                                        message:
                                            "Email verified and account created successfully.",
                                        user_id:
                                            result.insertId
                                    });
                                }
                            );
                        }
                    );
                }
            );

        } catch (error) {

            console.error(
                "OTP verification error:",
                error
            );

            return res.status(500).json({
                success: false,
                message:
                    "Server error."
            });
        }
    }
);


// ==========================================
// FORGOT PASSWORD - SEND OTP
// ==========================================

app.post("/api/users/forgot-password", async (req, res) => {

    try {

        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email is required."
            });
        }

        // Check whether the email belongs to a registered user
        const [users] = await db.promise().query(
            "SELECT user_id, name, email FROM users WHERE email = ?",
            [email]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "No account found with this email address."
            });
        }

        // Generate a new random 6-digit OTP
        const otp = generateOTP();

        // OTP is valid for 5 minutes
        const expiresAt = new Date(
            Date.now() + 5 * 60 * 1000
        );

        // Hash OTP before storing it
        const otpHash = await bcrypt.hash(otp, 10);

        // Remove any previous reset OTP
        await db.promise().query(
            "DELETE FROM password_resets WHERE email = ?",
            [email]
        );

        // Store new reset OTP
        await db.promise().query(
            `INSERT INTO password_resets
            (email, otp_hash, expires_at)
            VALUES (?, ?, ?)`,
            [email, otpHash, expiresAt]
        );

        // Send OTP through Gmail
        await transporter.sendMail({

            from: `"MarineGuard" <${process.env.EMAIL_USER}>`,

            to: email,

            subject: "MarineGuard Password Reset OTP",

            html: `
                <div style="font-family: Arial, sans-serif;">
                    <h2>MarineGuard Password Reset</h2>

                    <p>Hello ${users[0].name},</p>

                    <p>
                        Your password reset OTP is:
                    </p>

                    <h1 style="letter-spacing: 5px;">
                        ${otp}
                    </h1>

                    <p>
                        This OTP will expire in 5 minutes.
                    </p>

                    <p>
                        If you did not request a password reset,
                        you can ignore this email.
                    </p>
                </div>
            `
        });

        return res.json({
            success: true,
            message: "Password reset OTP sent successfully."
        });

    } catch (error) {

        console.error(
            "Forgot password error:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Unable to send password reset OTP."
        });
    }
});


// ==========================================
// RESET PASSWORD
// ==========================================

app.post("/api/users/reset-password", async (req, res) => {

    try {

        const {
            email,
            otp,
            newPassword
        } = req.body;

        if (!email || !otp || !newPassword) {
            return res.status(400).json({
                success: false,
                message: "Email, OTP and new password are required."
            });
        }

        // Password validation
        const passwordPattern =
            /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^A-Za-z\d]).{8,}$/;

        if (!passwordPattern.test(newPassword)) {
            return res.status(400).json({
                success: false,
                message:
                    "Password must contain 8+ characters, uppercase, lowercase, number and special character."
            });
        }

        // Find password reset request
        const [resetRows] = await db.promise().query(
            "SELECT * FROM password_resets WHERE email = ?",
            [email]
        );

        if (resetRows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "No password reset request found."
            });
        }

        const resetData = resetRows[0];

        // Check OTP expiry
        if (
            new Date(resetData.expires_at).getTime()
            < Date.now()
        ) {

            await db.promise().query(
                "DELETE FROM password_resets WHERE email = ?",
                [email]
            );

            return res.status(400).json({
                success: false,
                message: "OTP has expired. Please request a new OTP."
            });
        }

        // Compare entered OTP with stored hash
        const otpMatch =
            await bcrypt.compare(
                otp,
                resetData.otp_hash
            );

        if (!otpMatch) {
            return res.status(400).json({
                success: false,
                message: "Invalid OTP."
            });
        }

        // Hash the new password
        const newPasswordHash =
            await bcrypt.hash(newPassword, 10);

        // Update user's password
        const [updateResult] =
            await db.promise().query(
                `UPDATE users
                 SET password = ?
                 WHERE email = ?`,
                [newPasswordHash, email]
            );

        if (updateResult.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "User account not found."
            });
        }

        // Delete used OTP
        await db.promise().query(
            "DELETE FROM password_resets WHERE email = ?",
            [email]
        );

        return res.json({
            success: true,
            message: "Password changed successfully."
        });

    } catch (error) {

        console.error(
            "Reset password error:",
            error
        );

        return res.status(500).json({
            success: false,
            message: "Unable to reset password."
        });
    }
});


// ==========================================
// USER LOGIN
// ==========================================

app.post(

    "/api/users/login",

    (req, res) => {

        const {
            email,
            password
        } = req.body;


        if (
            !email ||
            !password
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Email and password are required."

            });

        }


        const sql = `

            SELECT

                user_id,
                name,
                email,
                password

            FROM users

            WHERE email = ?

        `;


        db.query(

            sql,

            [email],

            async (error, results) => {

                if (error) {

                    console.error(
                        "User login error:",
                        error
                    );

                    return res.status(500).json({

                        success: false,

                        message:
                            "Database error."

                    });

                }


                if (results.length === 0) {

                    return res.status(401).json({

                        success: false,

                        message:
                            "Invalid email or password."

                    });

                }


                const user =
                    results[0];


                const passwordMatch =
                    await bcrypt.compare(

                        password,

                        user.password

                    );


                if (!passwordMatch) {

                    return res.status(401).json({

                        success: false,

                        message:
                            "Invalid email or password."

                    });

                }


                // ==================================
                // CREATE USER JWT
                // ==================================

                const token =
                    jwt.sign(

                        {

                            user_id:
                                user.user_id,

                            name:
                                user.name,

                            email:
                                user.email,

                            role:
                                "user"

                        },

                        JWT_SECRET,

                        {
                            expiresIn: "2h"
                        }

                    );


                res.json({

                    success: true,

                    message:
                        "Login successful.",

                    token: token,

                    user: {

                        user_id:
                            user.user_id,

                        name:
                            user.name,

                        email:
                            user.email

                    }

                });

            }

        );

    }

);


// ==========================================
// START SERVER
// ==========================================

app.listen(

    PORT,

    () => {

        console.log(
            `🌊 MarineGuard backend running on http://localhost:${PORT}`
        );

    }

);