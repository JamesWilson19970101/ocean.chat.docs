# graphql vs http in oceanchat

## Background

Now I am the only developer work for the IM repository. This significantly influences the technology choice, primarily revolving around development efficiency, complexity, and maintenance cost. In this scenario, deciding between GraphQL and REST involves below trade-offs:

## Arguments for choosing REST

1. Faster Startup and Lower Initial Complexity: I am already familiar with REST, and nestjs has already provided the demo of REST Api when I initialized the working directory. Setting up REST Api is faster and less complex than configuring GraphQL. As a solo developer, delivering core features quickly is a higher priority.

2. Learning Curve: I am not familiar with GraphQL, I need additional time to learn its config(which involves schema design, writing resolvers etc.). In contrasting, Rest Api is more widely understood and intuitive.

3. Simplicity for Standard Scenarios: Many fundamental operations in IM app, like user authentication, fetching user list etc. can be implemented straightforwardly.

4. Ecosystem & Caching: REST leverages mature HTTP caching mechanisms more directly. While GraphQL has caching strategies, they often require more application-level consideration.

## Arguments for Choosing GraphQL

1. Client data fetching Flexibility: I am paying attention to both front and back end, I need to combine data when the data requirements is complex. If UI(There is no detailed planning for the UI at present. Since it is a personal development, UI design will be skipped for the time being.) changes often, GraphQL allows me writing precise reuest without needing backend API changes. 

2. Reduce NetWork Requests: For complex data and views, or data from multiple resources, GraphQL can fetch data in one request avoiding multiple round trips like REST.

3. Strong Typing: GraphQL's schema provides strong typing, this mechanism can help me avoid many mistakes during the coding stage

## My chioce

Time and energy are the most critical resources for me, a solo developer.

I think:

- I am familiar with REST.
- My IM client won't need complex data in the early programming stage(If client needs complex data later, I will introduce GraphQL after evaluation).

So I decide to use REST API.