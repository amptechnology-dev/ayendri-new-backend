const axios = require("axios");

const sendPasswordSMS = async (phone, email, password) => {

    try {

        if (!phone) return;

        const message = `is your OTP to login into AMDANI. Please do not share this OTP with anyone.- AMPTECH`;

        const params = {
            username: 'MTECHTRANS',
            apikey: '38892-B2424',
            apirequest: 'Text',
            sender: 'AMPTCH',
            mobile: phone,
            message,
            route: 'TRANS',
            TemplateID: '1407172715834228636',
            format: 'JSON'
        };

        const response = await axios.get(
            "http://text.mboxsolution.com/sms-panel/api/http/index.php",
            { params }
        );

        console.log("SMS API Response:", response.data);

        if (response.data.status !== "success") {
            console.error("SMS sending failed:", response.data);
            throw new Error("SMS sending failed");
        }

        console.log("Credential SMS sent successfully");

    } catch (error) {
        console.error("SMS Error:", error.message);
    }

};

module.exports = { sendPasswordSMS };