"use server";

type RepositoryArgs = {
  owner: string;
  name: string;
};

type StargazerEdge = { starredAt: string };

type StargazersResponse = {
  data?: {
    repository?: {
      stargazers?: {
        pageInfo?: { endCursor?: string; hasNextPage?: boolean };
        edges?: StargazerEdge[];
      };
    };
  };
};

type RepositoryResponse = {
  data?: {
    repository?: {
      forks?: { totalCount?: number };
      watchers?: { totalCount?: number };
      stargazers?: { totalCount?: number };
      commits?: { history?: { totalCount?: number } };
    };
  };
};

async function getAllStargazers({ owner, name }: RepositoryArgs) {
  let endCursor: string | undefined;
  let hasNextPage = true;
  let added: StargazerEdge[] = [];

  while (hasNextPage) {
    const request = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
      },
      body: JSON.stringify({
        variables: { after: endCursor, owner, name },
        query: `query Repository($owner: String!, $name: String!, $after: String) {
            repository(owner: $owner, name: $name) {
              stargazers (first: 100, after: $after) {
                pageInfo {
                  endCursor
                  hasNextPage
                }
                edges {
                 starredAt
                }
              }
            }
          }`,
      }),
    });

    const payload = (await request.json()) as StargazersResponse;
    const stargazers = payload.data?.repository?.stargazers;

    added = added.concat(stargazers?.edges ?? []);
    hasNextPage = stargazers?.pageInfo?.hasNextPage ?? false;
    endCursor = stargazers?.pageInfo?.endCursor;
  }

  return added;
}

async function githubRequest({ owner, name }: RepositoryArgs) {
  const request = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
    },
    body: JSON.stringify({
      variables: { owner, name },
      query: `query Repository($owner: String!, $name: String!) {
            repository(owner: $owner, name: $name) {
              forks {
                totalCount
              }
              watchers {
                totalCount
              }
              stargazers {
                totalCount
              }
               commits:object(expression: "main") {
                ... on Commit {
                  history {
                    totalCount
                  }
                }
              }
            }
          }`,
    }),
  });

  return (await request.json()) as RepositoryResponse;
}

export async function getGithubStats() {
  const stargazers = await getAllStargazers({
    owner: "midday-ai",
    name: "midday",
  });

  const payload = await githubRequest({
    owner: "midday-ai",
    name: "midday",
  });
  const repository = payload.data?.repository;

  const starsPerDate = stargazers.reduce<Record<string, number>>(
    (acc, curr) => {
      const date = curr.starredAt.substring(0, 10);

      acc[date] = (acc[date] ?? 0) + 1;
      return acc;
    },
    {},
  );

  const stats = Object.keys(starsPerDate).map((key) => {
    return {
      date: new Date(key),
      value: starsPerDate[key] ?? 0,
    };
  });

  return {
    stats,
    repository,
  };
}
