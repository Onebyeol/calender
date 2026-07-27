const mongoose = require('mongoose');

const todoSchema = new mongoose.Schema(
  {
    noticeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Notice',
      default: null,
    },
    title: {
      type: String,
      required: true,
    },
    due: {
      type: String, // YYYY-MM-DD
      required: true,
    },
    done: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Todo', todoSchema);
