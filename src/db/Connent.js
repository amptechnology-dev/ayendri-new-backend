const mongoose = require("mongoose")

const Conect = async () => {
    try {
        const connection = await mongoose.connect(process.env.DB)
        console.log(`mongodb conect at ${connection.connection.host}`)
    } catch (error) {
        console.log(error)
        process.exit(1)
    }
}

module.exports = Conect