const suite = {
  name: 'Features Tests',
  tests: [
    {
      name: 'Fetch post 1',
      operationId: 'fetchPost1',
      endpoint: '/posts/1',
      tags: ['posts', 'item'],
      postTest: (resp, state) => {
        state.postId = resp.data.id;
      }
    },
    {
      name: 'Create comment for post 1',
      operationId: 'createComment',
      dependsOn: ['fetchPost1'],
      endpoint: '/comments',
      request: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: { postId: 0, name: 'foo', body: 'bar', email: 'foo@bar.com' }
      },
      beforeSend: (req, state) => {
        const postId = state.completedCases.fetchPost1.response.data.id;
        req.data.postId = postId;
        return req;
      },
      response: {
        status: 201,
        json: { postId: 1 }
      },
      postTest: (resp, state) => {
        state.commentId = resp.data.id;
      }
    },
    {
      name: 'Fetch created comment',
      dependsOn: ['createComment'],
      endpoint: '/comments/0',
      beforeSend: (req, state) => {
        req.url = `/comments/${state.commentId}`;
        return req;
      },
      response: {
        status: 404
      }
    },
    {
      name: 'Skipped example test',
      endpoint: '/invalid',
      skip: true
    },
    {
      name: 'Bombard photos',
      endpoint: '/photos/1',
      bombard: 1
    },
    {
      name: 'Repeat todos list',
      endpoint: '/todos',
      repeat: 1
    },
    {
      name: 'Delayed album fetch',
      endpoint: '/albums/1',
      delay: 200
    }
  ]
};

export default suite;
