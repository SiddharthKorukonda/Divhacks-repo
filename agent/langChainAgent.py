import langChain

def create_agent(start):
    agent = langChain.Agent()
    return agent


if __name__ == "__main__":
    agent = create_agent("Hello, LangChain!")
    agent.run()