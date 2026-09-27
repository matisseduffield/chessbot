'use strict';
const { validateInbound, ClientMessageSchema } = require('@chessbot/shared');
module.exports = { validateInbound, InboundMessage: ClientMessageSchema };
