type MergeableMessage = {
	id: string;
};

export const mergeChatMessage = <
	PersistedMessage extends MergeableMessage,
	IncomingMessage extends MergeableMessage,
>(
	persistedMessages: PersistedMessage[],
	message?: IncomingMessage
): Array<IncomingMessage | PersistedMessage> => {
	if (!message) {
		return persistedMessages;
	}

	const messageIndex = persistedMessages.findIndex(
		(persistedMessage) => persistedMessage.id === message.id
	);

	if (messageIndex === -1) {
		return [...persistedMessages, message];
	}

	return persistedMessages.map((persistedMessage, index) =>
		index === messageIndex ? message : persistedMessage
	);
};
