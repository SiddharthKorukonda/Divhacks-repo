## Inspiration
The spread of misinformation is one of the greatest issues our society has ever faced. Since humanity has more information at its fingertips than ever before, we are uniquely vulnerable to spreading false claims.
## What it does
FastFacts uses a complex Agentic workflow by transcribing real-time audio and deciphering claims are being made. After the claims have been extracted, we used a langGraph pipeline to cross-reference the claims with recent articles then evaluate the accuracy of the claim. After the speaker finishes, there is a complete overview of the speaker's opinions and possible biases.
## How we built it
We created an electron desktop application that collects system audio with zero latency then streams the data to be transcribed. The transcribed data is then analyzed by a pipeline including Gemini 2.5 flash and Gemini 2.5 pro as well as Tavily MCP to compare to the most recent data available online. Once the claim has been analyzed, the user is immediately given the feedback to influence informed decision making when interacting with the content. Additionally, Comet's Opik is integrated into the LangGraph pipeline to ensure accuracy among agents.
## Challenges we ran into
The first challenge we ran into was gathering the computer audio. We decided not to use the microphone so that outside noises wouldn't interfere with transcription. MacOS doesn't provide a default api for accessing system audio so this was a particularly difficult challenge. Additionally, since this was a desktop app, creating the user interface posed unique challenges. This was our first time using LangGraph as well as making an agentic workflow so we had a large learning curve during this short period. Our most interesting challenge was passing the transcribed data into out initial agent that evaluated what is a claim since the agent didn't have the chance to see all of the data at the same time but instead incrementally got new parts of the transcription.
## Accomplishments that we're proud of
We were able to implement the langGraph pipeline on our own. We made our first desktop app. We overcame several major issues with the UI. We had realtime transcription. We solved the issue of incomplete claim creation by using a time buffer to segment our data. We got real-time comparison data from the web to cross-reference.
## What we learned
Technologies we learned were LangGraph, AI Agentic workflows, UI design, how to create desktop apps, typescript, realtime data analysis, cutting edge AI workflow tools
## What's next for FastFacts
Increasing analysis speed, increasing transcription accuracy, more cross referencing.

## Install

Clone the repo and install dependencies:

```bash
git clone --depth 1 --branch main https://github.com/SlinkyWalnut/Divhacks-repo.git
cd Divhacks-repo.git
npm install
```

**Having issues installing? See our [debugging guide](https://github.com/electron-react-boilerplate/electron-react-boilerplate/issues/400)**

## Starting Development

Start the app in the `dev` environment:

```bash
npm start
```

In separate turminal run

```cd agent
pip install -r requirements
python server.py
```



## License

MIT © [Electron React Boilerplate](https://github.com/electron-react-boilerplate)

[github-actions-status]: https://github.com/electron-react-boilerplate/electron-react-boilerplate/workflows/Test/badge.svg
[github-actions-url]: https://github.com/electron-react-boilerplate/electron-react-boilerplate/actions
[github-tag-image]: https://img.shields.io/github/tag/electron-react-boilerplate/electron-react-boilerplate.svg?label=version
[github-tag-url]: https://github.com/electron-react-boilerplate/electron-react-boilerplate/releases/latest
[stackoverflow-img]: https://img.shields.io/badge/stackoverflow-electron_react_boilerplate-blue.svg
[stackoverflow-url]: https://stackoverflow.com/questions/tagged/electron-react-boilerplate
