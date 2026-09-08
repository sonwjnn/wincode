const answerQuestion = (
	question,
	buttons,
	feedback,
	correctIndex,
	selectedIndex
) => {
	if (question.dataset.answered === "true") {
		return;
	}

	question.dataset.answered = "true";
	for (const choice of buttons) {
		choice.disabled = true;
	}

	const isCorrect = selectedIndex === correctIndex;
	const selectedButton = buttons[selectedIndex];
	selectedButton?.classList.add(isCorrect ? "correct" : "incorrect");
	if (!isCorrect) {
		buttons[correctIndex]?.classList.add("correct");
	}

	if (feedback) {
		feedback.classList.add(isCorrect ? "good" : "bad");
		feedback.textContent = isCorrect
			? (question.dataset.correctFeedback ?? "Đúng.")
			: (question.dataset.incorrectFeedback ??
				"Chưa đúng — xem đáp án màu xanh.");
	}
};

const quizzes = document.querySelectorAll("[data-quiz]");
for (const quiz of quizzes) {
	const questions = quiz.querySelectorAll("[data-question]");
	for (const question of questions) {
		const buttons = [...question.querySelectorAll("button")];
		const feedback = question.querySelector("[data-feedback]");
		const correctIndex = Number(question.dataset.correct);

		for (const [index, button] of buttons.entries()) {
			button.addEventListener("click", () => {
				answerQuestion(question, buttons, feedback, correctIndex, index);
			});
		}
	}
}
