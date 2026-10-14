const CounterModel = require("../model/counter.model.js");

const getNextSequence = async (name) => {
  const counter = await CounterModel.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true } 
  );
  return counter.seq;
};

module.exports = { getNextSequence };